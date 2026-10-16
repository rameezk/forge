import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import {
  errorMessage,
  githubAppFromEnv,
  queryPullRequestConflict,
  queryPullRequestHead,
  startHeartbeat,
  Store,
  type ConflictResolutionFailureRecord,
  type ConflictResolutionStart,
  type ConflictResolutionState,
  type Fetch,
  type GithubApp,
} from '@forge/shared';
import { maxConcurrentOf, repositoryTriggeredBy, resolveWorker } from './config.ts';
import { inspectCheckout, launchInCheckout } from './checkout-workload.ts';
import { gitEnvironment } from './git.ts';
import { conflictInstruction } from './harness.ts';
import { conflictedFiles, containsCommit } from './merge.ts';
import { fillPrompt, headRefusal, stateOf } from './pull-request-workload.ts';
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

const reportedConflicting = async (
  app: GithubApp,
  fetch: Fetch,
  github: string,
  number: number,
): Promise<boolean | null> => {
  for (let attempt = 1; ; attempt++) {
    const { mergeable } = await queryPullRequestConflict(
      fetch,
      (await app.mint(github, 'read')).token,
      github,
      number,
    );
    if (mergeable !== 'UNKNOWN') return mergeable === 'CONFLICTING';
    if (attempt === MERGEABLE_ATTEMPTS) return null;
    await sleep(MERGEABLE_DELAY_MS);
  }
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
}: Resolved): Promise<ConflictResolutionFailureRecord | undefined> => {
  const read = async () =>
    queryPullRequestConflict(fetch, (await app.mint(github, 'read')).token, github, number);
  const { headSha, baseSha } = await read();
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
  if (baseSha !== sha) return undefined;
  const conflicting = await reportedConflicting(app, fetch, github, number);
  if (conflicting === null) {
    return {
      reason: 'still-conflicting',
      detail: `GitHub did not say whether the pull request still conflicts with ${sha}`,
    };
  }
  return conflicting
    ? {
        reason: 'still-conflicting',
        detail: `GitHub still reports the pull request as conflicting with ${sha}`,
      }
    : undefined;
};

export const main = async (
  argv: string[],
  env: NodeJS.ProcessEnv,
  fetch: Fetch,
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
  const gitEnv = gitEnvironment(env, identity);
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
      let state: Exclude<ConflictResolutionState, 'running'> = 'ok';
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
          });
          state = stateOf(launched);
          code = launched.run.status === 'error' || launched.run.status === 'exceeded' ? 1 : 0;
          if (state === 'ok') {
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
            });
          }
        }
      } catch (error) {
        store.endConflictResolution(resolutionId, 'error', now(), {
          reason: 'crashed',
          detail: errorMessage(error),
        });
        throw error;
      }
      store.endConflictResolution(
        resolutionId,
        failure === undefined ? state : 'error',
        now(),
        failure,
      );
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
