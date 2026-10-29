import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import {
  errorMessage,
  githubAppFromEnv,
  queryPullRequestConflict,
  queryPullRequestHead,
  queryPullRequestReadiness,
  startHeartbeat,
  Store,
  type ConflictResolutionFailureRecord,
  type ConflictResolutionStart,
  type Fetch,
  type GithubApp,
  type Mergeable,
  type PullRequestConflict,
} from '@forge/shared';
import { maxConcurrentOf, repositoryTriggeredBy, resolveWorker } from './config.ts';
import { inspectCheckout, launchInCheckout } from './checkout-workload.ts';
import { gitEnvironment } from './git.ts';
import { conflictInstruction } from './harness.ts';
import { conflictedFiles, containsCommit } from './merge.ts';
import { endOf, fillPrompt, headRefusal, type WorkloadEnd } from './pull-request-workload.ts';
import { readRuntimeConfig, stateDirOf } from './workload.ts';

const now = (): string => new Date().toISOString();

const USAGE = 'usage: forge-resolve-conflicts <repository> <pull-request>';

const MERGEABLE_ATTEMPTS = 5;

const MERGEABLE_DELAY_MS = 2000;

const startRefusal = (start: Exclude<ConflictResolutionStart, { started: number }>): string => {
  switch (start.refused) {
    case 'resolving':
      return 'a conflict resolution of it is already running';
    case 'revising':
      return 'a revision of it is already running';
    case 'dispatching':
      return 'the dispatch that opened it is still running';
    case 'full':
      return `${start.live} ${start.live === 1 ? 'workload is' : 'workloads are'} already running, the most forge.runtime.dispatch.maxConcurrent allows`;
  }
};

type Pause = (ms: number) => Promise<void>;

const settledMergeable = async (
  read: () => Promise<PullRequestConflict>,
  first: Mergeable,
  pause: Pause,
): Promise<Mergeable> => {
  let mergeable = first;
  for (let attempt = 1; mergeable !== 'MERGEABLE' && attempt < MERGEABLE_ATTEMPTS; attempt++) {
    await pause(MERGEABLE_DELAY_MS);
    mergeable = (await read()).mergeable;
  }
  return mergeable;
};

interface Resolved {
  app: GithubApp;
  fetch: Fetch;
  env: NodeJS.ProcessEnv;
  gitEnv: Record<string, string>;
  github: string;
  number: number;
  branch: string;
  runId: string;
  sha: string;
  pause: Pause;
}

const unmetCondition = async ({
  app,
  fetch,
  env,
  gitEnv,
  github,
  number,
  branch,
  runId,
  sha,
  pause,
}: Resolved): Promise<ConflictResolutionFailureRecord | undefined> => {
  const read = async () =>
    queryPullRequestConflict(fetch, (await app.mint(github, 'read')).token, github, number);
  const first = await read();
  const { headSha, baseSha } = first;
  const merged = await inspectCheckout({
    env,
    github,
    branch,
    app,
    gitEnv,
    id: `${runId}-check`,
    inspect: (dir, cloneEnv) => containsCommit(dir, cloneEnv, headSha, sha),
  });
  if (!merged) {
    return {
      reason: 'not-merged',
      detail: `the pull request's head ${headSha} does not contain ${sha}`,
    };
  }
  if (baseSha === sha) {
    const mergeable = await settledMergeable(read, first.mergeable, pause);
    if (mergeable !== 'MERGEABLE') {
      return {
        reason: 'still-conflicting',
        detail:
          mergeable === 'CONFLICTING'
            ? `GitHub still reports the pull request as conflicting with ${sha}`
            : `GitHub did not say whether the pull request still conflicts with ${sha}`,
      };
    }
  }
  const { failing, pending } = await queryPullRequestReadiness(
    fetch,
    (await app.mint(github, 'read')).token,
    github,
    number,
  );
  if (failing.length > 0) return { reason: 'check-failed', detail: failing.join(', ') };
  if (pending.length > 0) return { reason: 'check-pending', detail: pending.join(', ') };
  return undefined;
};

export const main = async (
  argv: string[],
  env: NodeJS.ProcessEnv,
  fetch: Fetch,
  pause: Pause = (ms) => sleep(ms),
): Promise<number> => {
  const [name, number, ...rest] = argv;
  if (
    name === undefined ||
    number === undefined ||
    rest.length > 0 ||
    !/^[1-9][0-9]*$/.test(number)
  ) {
    throw new Error(USAGE);
  }
  const config = readRuntimeConfig(env);
  const repository = repositoryTriggeredBy(config.repositories, name, 'conflict');
  const worker = resolveWorker(config, repository.worker);
  const app = githubAppFromEnv(env, fetch);
  const identity = await app.identity(repository.github);
  const gitEnv = gitEnvironment(env, identity, { conflictResolution: true });
  const token = (await app.mint(repository.github, 'write')).token;
  const pullRequest = await queryPullRequestHead(fetch, token, repository.github, Number(number));
  const refused = headRefusal(pullRequest);
  if (refused !== null) {
    console.error(`${name}#${pullRequest.number} cannot have its conflicts resolved: ${refused}`);
    return 1;
  }
  const target = await queryPullRequestConflict(fetch, token, repository.github, pullRequest.number);

  const resolved = { repository: name, number: pullRequest.number, url: pullRequest.url };
  const runId = randomUUID();
  const store = Store.open(join(stateDirOf(env), 'forge.db'));
  try {
    const start = store.startConflictResolution(
      resolved,
      pullRequest.closes,
      runId,
      now(),
      maxConcurrentOf(config),
      { headSha: target.headSha, defaultSha: target.defaultSha },
    );
    if ('refused' in start) {
      console.error(
        `${name}#${pullRequest.number} cannot have its conflicts resolved: ${startRefusal(start)}`,
      );
      return 1;
    }
    const resolutionId = start.started;
    const stopHeartbeat = startHeartbeat(
      () => store.touchConflictResolution(resolutionId, now()),
      (error) =>
        console.error(
          `${name}#${pullRequest.number}: could not refresh its conflict resolution heartbeat: ${errorMessage(error)}`,
        ),
    );
    try {
      let failure: ConflictResolutionFailureRecord | undefined;
      let code = 0;
      let ended: WorkloadEnd = { state: 'done' };
      try {
        const files = await inspectCheckout({
          env,
          github: repository.github,
          branch: pullRequest.branch,
          app,
          gitEnv,
          id: `${runId}-trial`,
          inspect: (dir, cloneEnv) => conflictedFiles(dir, cloneEnv, target.defaultSha),
        });
        if (files.length > 0) {
          const launched = await launchInCheckout({
            env,
            config,
            worker: {
              ...worker,
              prompt: `${fillPrompt(worker.prompt, repository.github, pullRequest)}\n\n${conflictInstruction({
                number: pullRequest.number,
                url: pullRequest.url,
                branch: pullRequest.branch,
                defaultBranch: target.defaultBranch,
                sha: target.defaultSha,
                files,
              })}`,
              promptTemplate: worker.prompt,
            },
            github: repository.github,
            branch: pullRequest.branch,
            app,
            gitEnv,
            identity,
            runId,
            conflictResolution: true,
          });
          if (launched.run.harnessStartTime == null) {
            store.failConflictResolutionStart(
              resolutionId,
              launched.run.error ?? errorMessage(launched.cause),
              now(),
            );
            return 1;
          }
          ended = endOf(launched);
          code = launched.run.status === 'error' || launched.run.status === 'exceeded' ? 1 : 0;
          if (ended.state === 'done') {
            failure = await unmetCondition({
              app,
              fetch,
              env,
              gitEnv,
              github: repository.github,
              number: pullRequest.number,
              branch: pullRequest.branch,
              runId,
              sha: target.defaultSha,
              pause,
            });
          }
        }
      } catch (error) {
        if (store.getRun(runId)?.harnessStartTime == null) {
          store.failConflictResolutionStart(resolutionId, errorMessage(error), now());
        } else {
          store.endConflictResolution(resolutionId, 'failed', now(), {
            reason: 'crashed',
            detail: errorMessage(error),
          });
        }
        throw error;
      }
      const final = failure === undefined ? ended : { state: 'failed' as const, failure };
      store.endConflictResolution(resolutionId, final.state, now(), final.failure);
      return failure !== undefined ? 1 : code;
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
