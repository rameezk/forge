import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  errorMessage,
  githubWriteToken,
  queryPullRequestHead,
  startHeartbeat,
  Store,
  type Fetch,
  type PullRequestHead,
  type RevisionStart,
  type RevisionState,
} from '@forge/shared';
import {
  gitIdentityOf,
  maxConcurrentOf,
  resolveWorker,
  type RepositoryConfig,
} from './config.ts';
import { launchInCheckout } from './checkout-workload.ts';
import { gitEnvironment } from './git.ts';
import { REVISION_INSTRUCTION } from './harness.ts';
import { readRuntimeConfig, stateDirOf, type LaunchResult } from './workload.ts';

const now = (): string => new Date().toISOString();

const USAGE = 'usage: forge-revise <repository> <pull-request>';

const repositoryNamed = (
  repositories: Record<string, RepositoryConfig> | undefined,
  name: string,
): { github: string; worker: string } => {
  const repository =
    repositories !== undefined && Object.hasOwn(repositories, name)
      ? repositories[name]
      : undefined;
  if (repository === undefined) {
    throw new Error(`unknown repository '${name}'`);
  }
  const worker = repository.on?.feedback;
  if (worker === undefined) {
    throw new Error(`repository '${name}' declares no on.feedback worker`);
  }
  return { github: repository.github, worker };
};

const fillPrompt = (
  template: string,
  github: string,
  pullRequest: PullRequestHead,
): string =>
  template
    .replaceAll('{repo}', github)
    .replaceAll('{pr}', String(pullRequest.number))
    .replaceAll('{url}', pullRequest.url)
    .replaceAll('{branch}', pullRequest.branch);

const headRefusal = (pullRequest: PullRequestHead): string | null => {
  if (!pullRequest.open) return 'it is not open';
  if (pullRequest.fromFork) return 'its branch is on a fork';
  return null;
};

const startRefusal = (start: Exclude<RevisionStart, { started: number }>): string => {
  switch (start.refused) {
    case 'revising':
      return 'a revision of it is already running';
    case 'dispatching':
      return 'the dispatch that opened it is still running';
    case 'full':
      return `${start.live} ${start.live === 1 ? 'workload is' : 'workloads are'} already running, the most forge.runtime.dispatch.maxConcurrent allows`;
  }
};

const stateOf = ({ run }: LaunchResult): Exclude<RevisionState, 'running'> =>
  run.status === 'success' ? 'ok' : run.status === 'running' ? 'error' : run.status;

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
  const repository = repositoryNamed(config.repositories, name);
  const worker = resolveWorker(config, repository.worker);
  const identity = gitIdentityOf(config);
  const gitEnv = gitEnvironment(env, identity);
  const token = githubWriteToken(env);

  const pullRequest = await queryPullRequestHead(fetch, token, repository.github, Number(number));
  const refused = headRefusal(pullRequest);
  if (refused !== null) {
    console.error(`${name}#${pullRequest.number} cannot be revised: ${refused}`);
    return 1;
  }

  const store = Store.open(join(stateDirOf(env), 'forge.db'));
  try {
    const revised = { repository: name, number: pullRequest.number, url: pullRequest.url };
    const runId = randomUUID();
    const start = store.startRevision(
      revised,
      pullRequest.closes,
      runId,
      now(),
      maxConcurrentOf(config),
    );
    if ('refused' in start) {
      console.error(`${name}#${pullRequest.number} cannot be revised: ${startRefusal(start)}`);
      return 1;
    }
    const revisionId = start.started;
    const stopHeartbeat = startHeartbeat(
      () => store.touchRevision(revisionId, now()),
      (error) =>
        console.error(
          `${name}#${pullRequest.number}: could not refresh its revision heartbeat: ${errorMessage(error)}`,
        ),
    );
    try {
      let launched: LaunchResult;
      try {
        launched = await launchInCheckout({
          env,
          config,
          worker: {
            ...worker,
            prompt: fillPrompt(worker.prompt, repository.github, pullRequest),
            promptTemplate: worker.prompt,
          },
          github: repository.github,
          branch: pullRequest.branch,
          instruction: REVISION_INSTRUCTION,
          token,
          gitEnv,
          identity,
          runId,
        });
      } catch (error) {
        store.endRevision(revisionId, 'error', now());
        throw error;
      }
      store.endRevision(revisionId, stateOf(launched), now());
      return launched.run.status === 'error' || launched.run.status === 'exceeded' ? 1 : 0;
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
