import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  errorMessage,
  DISPATCH_HEARTBEAT_MS,
  FORGE_DONE,
  FORGE_FAILED,
  FORGE_READY,
  FORGE_RUNNING,
  hasOpenClosingPullRequest,
  githubWriteToken,
  offFrontier,
  queryLabelled,
  queryTicket,
  Store,
  swapLabel,
  type DispatchOutcome,
  type DispatchTicket,
  type Fetch,
  type TicketState,
} from '@forge/shared';
import {
  resolveWorker,
  type RepositoryConfig,
  type RuntimeConfig,
} from './config.ts';
import type { Worker } from './harness.ts';
import {
  cloneCheckout,
  loadPiSkills,
  resolveCheckout,
  SkillNotFound,
} from './checkout.ts';
import {
  absolutePath,
  launchWorkload,
  readRuntimeConfig,
  stateDirOf,
  type LaunchResult,
} from './workload.ts';

const now = (): string => new Date().toISOString();

const USAGE = 'usage: forge-dispatch <repository> <issue>';

const refusal = (ticket: TicketState): string | null =>
  offFrontier(ticket) ??
  (ticket.labels.includes(FORGE_READY) ? null : `it is not labelled ${FORGE_READY}`);

const fillPrompt = (
  template: string,
  github: string,
  ticket: TicketState,
): string =>
  template
    .replaceAll('{repo}', github)
    .replaceAll('{issue}', String(ticket.number))
    .replaceAll('{url}', ticket.url);

const outcomeOf = (
  pullRequestOpen: boolean,
  { run, finalMessage, cause }: LaunchResult,
): DispatchOutcome => {
  if (pullRequestOpen) return { state: 'done' };
  if (cause instanceof SkillNotFound) {
    return { state: 'failed', reason: 'skill-not-found', detail: run.error };
  }
  if (run.status === 'error') {
    return { state: 'failed', reason: 'errored', detail: run.error };
  }
  return { state: 'failed', reason: 'no-pull-request', detail: finalMessage };
};

const repositoryNamed = (
  repositories: Record<string, RepositoryConfig> | undefined,
  name: string,
): RepositoryConfig & { worker: string } => {
  const repository =
    repositories !== undefined && Object.hasOwn(repositories, name)
      ? repositories[name]
      : undefined;
  if (repository === undefined) {
    throw new Error(`unknown repository '${name}'`);
  }
  if (repository.worker === undefined) {
    throw new Error(`repository '${name}' declares no worker`);
  }
  return { github: repository.github, worker: repository.worker };
};

const reconcileInterrupted = async (
  store: Store,
  repositories: Record<string, RepositoryConfig> | undefined,
  fetch: Fetch,
  token: string,
): Promise<void> => {
  for (const [name, { github, worker }] of Object.entries(repositories ?? {})) {
    if (worker === undefined) continue;
    try {
      for (const issue of await queryLabelled(fetch, token, github, FORGE_RUNNING)) {
        const settled = store.reconcileDispatch({ repository: name, ...issue }, now());
        if (settled !== null) {
          await swapLabel(
            fetch,
            token,
            github,
            issue.number,
            FORGE_RUNNING,
            settled === 'done' ? FORGE_DONE : FORGE_FAILED,
          );
          console.error(`${name}#${issue.number} was settled as ${settled}`);
        }
      }
    } catch (error) {
      console.error(
        `${name}: could not reconcile interrupted dispatches: ${errorMessage(error)}`,
      );
    }
  }
};

const launch = async ({
  env,
  config,
  worker,
  github,
  token,
  ticket,
  runId,
}: {
  env: NodeJS.ProcessEnv;
  config: RuntimeConfig;
  worker: Worker;
  github: string;
  token: string;
  ticket: DispatchTicket;
  runId: string;
}): Promise<LaunchResult> => {
  const loadSkills = await loadPiSkills(absolutePath(env, 'FORGE_PI_PACKAGE'));
  const workloadEnv = { ...env, GITHUB_TOKEN: token };
  return launchWorkload({
    config,
    worker,
    env: workloadEnv,
    secrets: [token],
    ticket,
    runId,
    openWorkspace: async (workDir) => {
      await cloneCheckout(github, workDir, workloadEnv);
      return { workDir, checkout: resolveCheckout(workDir, loadSkills) };
    },
  });
};

export const main = async (
  argv: string[],
  env: NodeJS.ProcessEnv,
  fetch: Fetch,
): Promise<number> => {
  const [name, issue, ...rest] = argv;
  if (
    name === undefined ||
    issue === undefined ||
    rest.length > 0 ||
    !/^[1-9][0-9]*$/.test(issue)
  ) {
    throw new Error(USAGE);
  }
  const config = readRuntimeConfig(env);
  const repository = repositoryNamed(config.repositories, name);
  const worker = resolveWorker(config, repository.worker);
  const token = githubWriteToken(env);

  const store = Store.open(join(stateDirOf(env), 'forge.db'));
  try {
    await reconcileInterrupted(store, config.repositories, fetch, token);

    const ticket = await queryTicket(
      fetch,
      token,
      repository.github,
      Number(issue),
    );
    const refused = refusal(ticket);
    if (refused !== null) {
      console.error(`${name}#${ticket.number} is not dispatchable: ${refused}`);
      return 1;
    }

    const dispatched = { repository: name, number: ticket.number, url: ticket.url };
    const runId = randomUUID();
    const dispatchId = store.startDispatch(dispatched, runId, now());
    if (dispatchId === null) {
      console.error(
        `${name}#${ticket.number} is not dispatchable: it is already being dispatched`,
      );
      return 1;
    }
    const heartbeat = setInterval(
      () => store.touchDispatch(dispatchId, now()),
      DISPATCH_HEARTBEAT_MS,
    );
    try {
      const failingAs =
        (stage: string) =>
        (error: unknown): never => {
          store.endDispatch(
            dispatchId,
            { state: 'failed', reason: 'errored', detail: `${stage}: ${errorMessage(error)}` },
            now(),
          );
          throw error;
        };
      const relabel = (from: string, to: string): Promise<void> =>
        swapLabel(fetch, token, repository.github, ticket.number, from, to);

      await relabel(FORGE_READY, FORGE_RUNNING).catch(
        failingAs('could not claim the ticket'),
      );
      const launched = await launch({
        env,
        config,
        worker: { ...worker, prompt: fillPrompt(worker.prompt, repository.github, ticket) },
        github: repository.github,
        token,
        ticket: dispatched,
        runId,
      }).catch(failingAs('could not start the workload'));
      const outcome = await hasOpenClosingPullRequest(
        fetch,
        token,
        repository.github,
        ticket.number,
      )
        .then((pullRequestOpen) => outcomeOf(pullRequestOpen, launched))
        .then(async (settled) => {
          await relabel(FORGE_RUNNING, settled.state === 'done' ? FORGE_DONE : FORGE_FAILED);
          return settled;
        })
        .catch(failingAs('could not record the outcome'));
      store.endDispatch(dispatchId, outcome, now());
      return launched.run.status === 'error' ? 1 : 0;
    } finally {
      clearInterval(heartbeat);
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
