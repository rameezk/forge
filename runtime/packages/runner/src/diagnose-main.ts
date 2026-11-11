import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import {
  DIAGNOSIS_FILE,
  MAX_VERDICT_BYTES,
  errorMessage,
  githubAppFromEnv,
  parseVerdict,
  rawEventsRef,
  requestRecordRef,
  startHeartbeat,
  Store,
  type DiagnosisRecord,
  type DiagnosisVerdict,
  type Fetch,
  type RunRecord,
} from '@forge/shared';
import { diagnosisWorkerOf, resolveWorker, type RuntimeConfig } from './config.ts';
import { DIAGNOSIS_INSTRUCTION, diagnosisContext, withContext, type DiagnosisBrief } from './harness.ts';
import { GithubTokenFile, keepFresh } from './github-token-file.ts';
import { launchWorkload, readRuntimeConfig, stateDirOf, type LaunchResult } from './workload.ts';

const now = (): string => new Date().toISOString();

const USAGE = 'usage: forge-diagnose-run <diagnosis-run> | forge-diagnose-run --rerun <run> [worker]';

const briefOf = (
  store: Store,
  failed: RunRecord,
  stateDir: string,
): { brief: DiagnosisBrief; readOnlyPaths: string[] } | null => {
  const at = now();
  const dispatch = store.dispatchOfRun(failed.id, at);
  const pullRequestWorkload = store.pullRequestWorkloadOfRun(failed.id, at);
  const workload =
    dispatch !== null
      ? { kind: 'dispatch', ...dispatch }
      : pullRequestWorkload === null
        ? null
        : { kind: pullRequestWorkload.kind, ...pullRequestWorkload.workload };
  if (workload === null) return null;
  const transcripts = join(stateDir, 'transcripts');
  const runDirectory = join(stateDir, 'work', failed.id);
  const files = [
    ...(failed.transcriptRef === null ? [] : [join(transcripts, failed.transcriptRef)]),
    join(transcripts, rawEventsRef(failed.id)),
    join(transcripts, requestRecordRef(failed.id)),
  ].filter((path) => existsSync(path));
  const hasDirectory = existsSync(runDirectory);
  return {
    brief: {
      failedRunId: failed.id,
      kind: workload.kind === 'conflict-resolution' ? 'conflict resolution' : workload.kind,
      repository: workload.repository,
      number: workload.number,
      reason: workload.reason ?? 'unknown',
      detail: workload.detail,
      error: failed.error,
      transcript: join(transcripts, failed.transcriptRef ?? `${failed.id}.jsonl`),
      requestRecord: join(transcripts, requestRecordRef(failed.id)),
      runDirectory: hasDirectory ? runDirectory : null,
    },
    readOnlyPaths: [...files, ...(hasDirectory ? [runDirectory] : [])],
  };
};

const readVerdictFile = (file: string): string => {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === 'ENOENT') throw new Error(`the agent wrote no ${DIAGNOSIS_FILE}`);
    if (code === 'ELOOP') throw new Error(`${DIAGNOSIS_FILE} must be a regular file`);
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${DIAGNOSIS_FILE} must be a regular file`);
    const buffer = Buffer.alloc(MAX_VERDICT_BYTES + 1);
    let length = 0;
    for (let read = 1; read > 0 && length < buffer.length; length += read) {
      read = readSync(fd, buffer, length, buffer.length - length, length);
    }
    if (length > MAX_VERDICT_BYTES) throw new Error(`${DIAGNOSIS_FILE} must be at most ${MAX_VERDICT_BYTES} bytes`);
    return buffer.toString('utf8', 0, length);
  } finally {
    closeSync(fd);
  }
};

const verdictOf = (stateDir: string, runId: string): DiagnosisVerdict =>
  parseVerdict(readVerdictFile(join(stateDir, 'work', runId, DIAGNOSIS_FILE)));

const endOf = (launched: LaunchResult, stateDir: string): { verdict: DiagnosisVerdict } | { detail: string } => {
  const { run } = launched;
  if (run.status === 'exceeded') return { detail: `the diagnosis exceeded its ${run.exceededLimit ?? 'limit'}` };
  if (run.status !== 'success') return { detail: run.error ?? `the diagnosis ended ${run.status}` };
  try {
    return { verdict: verdictOf(stateDir, run.id) };
  } catch (error) {
    return { detail: errorMessage(error) };
  }
};

type Invocation =
  | { kind: 'unit'; runId: string }
  | { kind: 'rerun'; failedRunId: string; workerName: string | null };

const invocationOf = (argv: string[]): Invocation => {
  const [first, failedRunId, workerName, ...rest] = argv;
  if (first === '--rerun') {
    if (failedRunId === undefined || rest.length > 0) throw new Error(USAGE);
    return { kind: 'rerun', failedRunId, workerName: workerName ?? null };
  }
  if (first === undefined || failedRunId !== undefined) throw new Error(USAGE);
  return { kind: 'unit', runId: first };
};

const NO_WORKER = 'no diagnosis worker is configured: set forge.runtime.diagnosis.worker';

const startRerun = (
  store: Store,
  config: RuntimeConfig,
  stateDir: string,
  failedRunId: string,
  requested: string | null,
): { diagnosis: DiagnosisRecord; workerName: string } => {
  const workerName = requested ?? diagnosisWorkerOf(config);
  if (workerName === null) throw new Error(NO_WORKER);
  resolveWorker(config, workerName);
  const at = now();
  if (store.diagnosisOfRun(failedRunId, at) !== null) throw new Error(`${failedRunId} is a diagnosis, which is never diagnosed`);
  const failed = store.getRun(failedRunId);
  if (failed === undefined) throw new Error(`${failedRunId} is not recorded`);
  if (briefOf(store, failed, stateDir) === null) {
    throw new Error(`${failedRunId} is not a dispatch, revision or conflict resolution`);
  }
  if (failed.transcriptRef === null || !existsSync(join(stateDir, 'transcripts', failed.transcriptRef))) {
    throw new Error(`${failedRunId} has no transcript left to diagnose`);
  }
  if (store.diagnosesOf(failedRunId, at).some(({ state }) => state === 'running')) {
    throw new Error(`${failedRunId} is already being diagnosed`);
  }
  const runId = randomUUID();
  store.startDiagnosis(failedRunId, runId, at);
  return { diagnosis: store.diagnosisOfRun(runId, at) as DiagnosisRecord, workerName };
};

export const main = async (argv: string[], env: NodeJS.ProcessEnv, fetch: Fetch): Promise<number> => {
  const invocation = invocationOf(argv);
  const stateDir = stateDirOf(env);
  const store = Store.open(join(stateDir, 'forge.db'));
  let diagnosis: DiagnosisRecord | null = null;
  const fail = (detail: string): void => {
    if (diagnosis !== null) store.endDiagnosis(diagnosis.id, 'failed', now(), { detail });
  };
  try {
    let config: RuntimeConfig;
    let workerName: string;
    if (invocation.kind === 'rerun') {
      config = readRuntimeConfig(env);
      ({ diagnosis, workerName } = startRerun(store, config, stateDir, invocation.failedRunId, invocation.workerName));
    } else {
      diagnosis = store.diagnosisOfRun(invocation.runId, now());
      if (diagnosis === null || diagnosis.state !== 'running') {
        throw new Error(`${invocation.runId} is not a running diagnosis`);
      }
      try {
        config = readRuntimeConfig(env);
        const configured = diagnosisWorkerOf(config);
        if (configured === null) throw new Error(NO_WORKER);
        workerName = configured;
      } catch (error) {
        fail(errorMessage(error));
        throw error;
      }
    }
    const { id, runId } = diagnosis;
    const stopHeartbeat = startHeartbeat(
      () => store.touchDiagnosis(id, now()),
      (error) => console.error(`${runId}: could not refresh its diagnosis heartbeat: ${errorMessage(error)}`),
    );
    try {
      const worker = resolveWorker(config, workerName);
      const failed = store.getRun(diagnosis.failedRunId);
      if (failed === undefined) throw new Error(`the failed run ${diagnosis.failedRunId} is not recorded`);
      const prepared = briefOf(store, failed, stateDir);
      if (prepared === null) throw new Error(`${failed.id} is not a dispatch, revision or conflict resolution`);
      const { brief, readOnlyPaths } = prepared;
      const github = config.repositories?.[brief.repository]?.github;
      if (github === undefined) throw new Error(`${brief.repository} is not a managed repository`);
      const app = githubAppFromEnv(env, fetch);
      const redactions: string[] = [];
      const minted = await app.mint(github, 'read');
      const tokenFile = GithubTokenFile.create(join(stateDir, 'credentials'), runId, minted.token, redactions);
      const stopRefreshing = keepFresh(tokenFile, minted, () => app.mint(github, 'read'), (error) =>
        console.error(`could not refresh the diagnosis's GitHub token: ${errorMessage(error)}`),
      );
      let launched: LaunchResult;
      try {
        launched = await launchWorkload({
          config,
          worker: {
            ...worker,
            prompt: withContext(worker.prompt, diagnosisContext(brief)),
            promptTemplate: worker.prompt,
          },
          env,
          harnessEnv: tokenFile.environment,
          secrets: () => redactions,
          ...(failed.ticket === null ? {} : { ticket: failed.ticket }),
          runId,
          openWorkspace: (workDir) => {
            mkdirSync(workDir, { recursive: true });
            return { workDir, instruction: DIAGNOSIS_INSTRUCTION, readOnlyPaths };
          },
        });
      } finally {
        stopRefreshing();
        tokenFile.remove();
      }
      const ended = endOf(launched, stateDir);
      if ('verdict' in ended) {
        store.endDiagnosis(id, 'done', now(), { verdict: ended.verdict });
        return 0;
      }
      store.endDiagnosis(id, 'failed', now(), ended);
      return 1;
    } catch (error) {
      fail(errorMessage(error));
      throw error;
    } finally {
      stopHeartbeat();
    }
  } finally {
    store.close();
  }
};

if (import.meta.filename === process.argv[1]) {
  main(process.argv.slice(2), process.env, globalThis.fetch)
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(errorMessage(error));
      process.exit(1);
    });
}
