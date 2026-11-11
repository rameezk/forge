import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
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
import { diagnosisWorkerOf, resolveWorker } from './config.ts';
import { DIAGNOSIS_INSTRUCTION, diagnosisContext, withContext, type DiagnosisBrief } from './harness.ts';
import { GithubTokenFile, keepFresh } from './github-token-file.ts';
import { launchWorkload, readRuntimeConfig, stateDirOf, type LaunchResult } from './workload.ts';

const now = (): string => new Date().toISOString();

const USAGE = 'usage: forge-diagnose <diagnosis-run>';

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

const verdictOf = (stateDir: string, runId: string): DiagnosisVerdict => {
  const file = join(stateDir, 'work', runId, DIAGNOSIS_FILE);
  if (!existsSync(file)) throw new Error(`the agent wrote no ${DIAGNOSIS_FILE}`);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_VERDICT_BYTES) {
    throw new Error(`${DIAGNOSIS_FILE} must be a regular file of at most ${MAX_VERDICT_BYTES} bytes`);
  }
  return parseVerdict(readFileSync(file, 'utf8'));
};

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

export const main = async (argv: string[], env: NodeJS.ProcessEnv, fetch: Fetch): Promise<number> => {
  const [runId, ...rest] = argv;
  if (runId === undefined || rest.length > 0) throw new Error(USAGE);
  const stateDir = stateDirOf(env);
  const store = Store.open(join(stateDir, 'forge.db'));
  let diagnosis: DiagnosisRecord | null = null;
  const fail = (detail: string): void => {
    if (diagnosis !== null) store.endDiagnosis(diagnosis.id, 'failed', now(), { detail });
  };
  try {
    diagnosis = store.diagnosisOfRun(runId, now());
    if (diagnosis === null || diagnosis.state !== 'running') {
      throw new Error(`${runId} is not a running diagnosis`);
    }
    const { id } = diagnosis;
    const stopHeartbeat = startHeartbeat(
      () => store.touchDiagnosis(id, now()),
      (error) => console.error(`${runId}: could not refresh its diagnosis heartbeat: ${errorMessage(error)}`),
    );
    try {
      const config = readRuntimeConfig(env);
      const workerName = diagnosisWorkerOf(config);
      if (workerName === null) throw new Error('no diagnosis worker is configured: set forge.runtime.diagnosis.worker');
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
