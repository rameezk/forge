import { setTimeout as sleep } from 'node:timers/promises';
import {
  errorMessage,
  queryPullRequestConflict,
  queryPullRequestReadiness,
  type ConflictResolutionFailureRecord,
  type Fetch,
  type GithubApp,
  type Mergeable,
  type PullRequestConflict,
} from '@forge/shared';
import { setupTimeoutOf } from './config.ts';
import { inspectCheckout } from './checkout-workload.ts';
import { CONFLICT_INSTRUCTION, conflictBrief } from './harness.ts';
import { conflictedFiles, containsCommit } from './merge.ts';
import { runPullRequestWorkload, type PullRequestKind } from './pull-request-workload.ts';

type Pause = (ms: number) => Promise<void>;

const MERGEABLE_ATTEMPTS = 5;

const MERGEABLE_DELAY_MS = 2000;

const settledMergeable = async (
  read: () => Promise<PullRequestConflict>,
  first: PullRequestConflict,
  sha: string,
  pause: Pause,
): Promise<Mergeable | undefined> => {
  let current = first;
  for (let attempt = 1; ; attempt++) {
    if (current.defaultSha !== sha) return undefined;
    if (current.mergeable === 'MERGEABLE' || attempt >= MERGEABLE_ATTEMPTS) {
      return current.mergeable;
    }
    await pause(MERGEABLE_DELAY_MS);
    current = await read();
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
  const { headSha } = first;
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
  const mergeable = await settledMergeable(read, first, sha, pause);
  if (mergeable !== undefined && mergeable !== 'MERGEABLE') {
    return {
      reason: 'still-conflicting',
      detail:
        mergeable === 'CONFLICTING'
          ? `GitHub still reports the pull request as conflicting with ${sha}`
          : `GitHub did not say whether the pull request still conflicts with ${sha}`,
    };
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

const conflictResolution = (pause: Pause): PullRequestKind<'conflict'> => ({
  command: 'forge-resolve-conflicts',
  trigger: 'conflict',
  refusal: 'cannot have its conflicts resolved',
  noun: 'conflict resolution',
  launch: { instruction: CONFLICT_INSTRUCTION, conflictResolution: true },
  prepare: ({ fetch, token, github, pullRequest }) =>
    queryPullRequestConflict(fetch, token, github, pullRequest.number),
  before: async ({ env, config, app, gitEnv, github, pullRequest, runId }, target) => {
    const files = await inspectCheckout({
      env,
      github,
      branch: pullRequest.branch,
      app,
      gitEnv,
      id: `${runId}-trial`,
      inspect: (dir, cloneEnv, signal) =>
        conflictedFiles(dir, cloneEnv, target.defaultSha, signal),
      setupTimeoutSeconds: setupTimeoutOf(config),
    });
    return files.length === 0
      ? null
      : {
          context: conflictBrief({
            number: pullRequest.number,
            url: pullRequest.url,
            branch: pullRequest.branch,
            defaultBranch: target.defaultBranch,
            sha: target.defaultSha,
            files,
          }),
          carried: null,
        };
  },
  after: ({ app, fetch, env, gitEnv, github, pullRequest, runId }, target) =>
    unmetCondition({
      app,
      fetch,
      env,
      gitEnv,
      github,
      number: pullRequest.number,
      branch: pullRequest.branch,
      runId,
      sha: target.defaultSha,
      pause,
    }),
});

export const main = (
  argv: string[],
  env: NodeJS.ProcessEnv,
  fetch: Fetch,
  pause: Pause = (ms) => sleep(ms),
): Promise<number> => runPullRequestWorkload(conflictResolution(pause), argv, env, fetch);

if (import.meta.filename === process.argv[1]) {
  main(process.argv.slice(2), process.env, globalThis.fetch)
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(errorMessage(error));
      process.exit(1);
    });
}
