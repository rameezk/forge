import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  errorMessage,
  FORGE_DONE,
  FORGE_FAILED,
  FORGE_READY,
  FORGE_RUNNING,
  hasOpenClosingPullRequest,
  labelExists,
  githubWriteToken,
  offFrontier,
  queryTicket,
  Store,
  relabel,
  settleRunningTickets,
  startHeartbeat,
  type DispatchOutcome,
  type DispatchStart,
  type DispatchTicket,
  type Fetch,
  type TicketState,
} from '@forge/shared';
import {
  maxConcurrentOf,
  resolveWorker,
  type GitIdentity,
  type RepositoryConfig,
  type RuntimeConfig,
} from './config.ts';
import { gitEnvironment } from './git.ts';
import type { Worker } from './harness.ts';
import {
  cloneCheckout,
  loadPiSkills,
  resolveCheckout,
  SkillNotFound,
} from './checkout.ts';
import { DevShellFailed, enterDevShell, nixErrorOf } from './devshell.ts';
import {
  absolutePath,
  launchWorkload,
  readRuntimeConfig,
  sandboxOf,
  stateDirOf,
  systemEnvironment,
  type LaunchResult,
} from './workload.ts';

const now = (): string => new Date().toISOString();

const USAGE = 'usage: forge-dispatch <repository> <issue>';

const refusal = async (
  ticket: TicketState,
  forgeLabelsExist: () => Promise<boolean>,
  github: string,
): Promise<string | null> => {
  const off = offFrontier(ticket);
  if (off !== null) return off;
  if (ticket.labels.includes(FORGE_READY)) return null;
  return (await forgeLabelsExist())
    ? `it is not labelled ${FORGE_READY}`
    : `the forge labels are missing from ${github}, and the frontier sync creates them once it has the GitHub write token`;
};

const startRefusal = (start: Exclude<DispatchStart, { started: number }>): string =>
  start.refused === 'dispatching'
    ? 'it is already being dispatched'
    : `${start.live} dispatched ${start.live === 1 ? 'workload is' : 'workloads are'} already running, the most forge.runtime.dispatch.maxConcurrent allows`;

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
  if (cause instanceof DevShellFailed) {
    return { state: 'failed', reason: 'devshell-failed', detail: nixErrorOf(run.error) };
  }
  if (run.status === 'error') {
    return { state: 'failed', reason: 'errored', detail: run.error };
  }
  return { state: 'failed', reason: 'no-pull-request', detail: finalMessage };
};

const nixSystemOf = (env: NodeJS.ProcessEnv): string => {
  const system = env.FORGE_NIX_SYSTEM;
  if (system === undefined) {
    throw new Error('FORGE_NIX_SYSTEM is not set');
  }
  return system;
};

const gitIdentityOf = (config: RuntimeConfig): GitIdentity => {
  const identity = config.dispatch?.gitIdentity;
  if (identity === undefined) {
    throw new Error('forge.runtime.dispatch.gitIdentity is not set');
  }
  return identity;
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

const settleAllRunningTickets = async (
  store: Store,
  repositories: Record<string, RepositoryConfig> | undefined,
  fetch: Fetch,
  token: string,
): Promise<void> => {
  for (const [name, { github, worker }] of Object.entries(repositories ?? {})) {
    if (worker === undefined) continue;
    await settleRunningTickets({
      store,
      fetch,
      token: () => token,
      repository: name,
      github,
      now,
      log: (line) => console.error(line),
    });
  }
};

const launch = async ({
  env,
  config,
  worker,
  github,
  token,
  gitEnv,
  identity,
  ticket,
  runId,
}: {
  env: NodeJS.ProcessEnv;
  config: RuntimeConfig;
  worker: Worker;
  github: string;
  token: string;
  gitEnv: Record<string, string>;
  identity: GitIdentity;
  ticket: DispatchTicket;
  runId: string;
}): Promise<LaunchResult> => {
  const loadSkills = await loadPiSkills(absolutePath(env, 'FORGE_PI_PACKAGE'));
  const nixSystem = nixSystemOf(env);
  const cloneEnv = { ...env, GITHUB_TOKEN: token, ...gitEnv };
  return launchWorkload({
    config,
    worker,
    env,
    harnessEnv: { GITHUB_TOKEN: token, ...gitEnvironment({}, identity) },
    secrets: [token],
    ticket,
    runId,
    openWorkspace: async (workDir) => {
      await cloneCheckout(github, workDir, cloneEnv);
      const checkout = resolveCheckout(workDir, loadSkills);
      const devShell = await enterDevShell({
        sandbox: sandboxOf(env),
        system: nixSystem,
        root: checkout.root,
        env: systemEnvironment(env),
      });
      return { workDir, checkout, ...(devShell === undefined ? {} : { devShell }) };
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
  const identity = gitIdentityOf(config);
  const gitEnv = gitEnvironment(env, identity);
  const token = githubWriteToken(env);

  const store = Store.open(join(stateDirOf(env), 'forge.db'));
  try {
    await settleAllRunningTickets(store, config.repositories, fetch, token);

    const ticket = await queryTicket(
      fetch,
      token,
      repository.github,
      Number(issue),
    );
    const refused = await refusal(
      ticket,
      () => labelExists(fetch, token, repository.github, FORGE_READY),
      repository.github,
    );
    if (refused !== null) {
      console.error(`${name}#${ticket.number} is not dispatchable: ${refused}`);
      return 1;
    }

    const dispatched = { repository: name, number: ticket.number, url: ticket.url };
    const runId = randomUUID();
    const start = store.startDispatch(dispatched, runId, now(), maxConcurrentOf(config));
    if ('refused' in start) {
      console.error(`${name}#${ticket.number} is not dispatchable: ${startRefusal(start)}`);
      return 1;
    }
    const dispatchId = start.started;
    const stopHeartbeat = startHeartbeat(
      () => store.touchDispatch(dispatchId, now()),
      (error) =>
        console.error(
          `${name}#${ticket.number}: could not refresh its dispatch heartbeat: ${errorMessage(error)}`,
        ),
    );
    try {
      const failAs = (stage: string, error: unknown): never => {
        store.endDispatch(
          dispatchId,
          { state: 'failed', reason: 'errored', detail: `${stage}: ${errorMessage(error)}` },
          now(),
        );
        throw error;
      };

      try {
        await relabel(fetch, token, repository.github, ticket.number, FORGE_RUNNING, [
          FORGE_READY,
        ]);
      } catch (error) {
        return failAs('could not claim the ticket', error);
      }

      let launched: LaunchResult;
      try {
        launched = await launch({
          env,
          config,
          worker: { ...worker, prompt: fillPrompt(worker.prompt, repository.github, ticket) },
          github: repository.github,
          token,
          gitEnv,
          identity,
          ticket: dispatched,
          runId,
        });
      } catch (error) {
        return failAs('could not start the workload', error);
      }

      let pullRequestOpen: boolean;
      try {
        pullRequestOpen = await hasOpenClosingPullRequest(
          fetch,
          token,
          repository.github,
          ticket.number,
        );
      } catch (error) {
        return failAs('could not check for a pull request', error);
      }

      const outcome = outcomeOf(pullRequestOpen, launched);
      store.endDispatch(dispatchId, outcome, now());
      await relabel(
        fetch,
        token,
        repository.github,
        ticket.number,
        outcome.state === 'done' ? FORGE_DONE : FORGE_FAILED,
        [FORGE_RUNNING, FORGE_READY],
      );
      return launched.run.status === 'error' ? 1 : 0;
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
