import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  cachedTokens,
  errorMessage,
  FORGE_READY,
  FORGE_RUNNING,
  findOpenClosingPullRequest,
  githubAppFromEnv,
  isApprovedByMaintainer,
  labelExists,
  maintainerLookup,
  offFrontier,
  queryPullRequestReadiness,
  queryTicket,
  refuseTicket,
  Store,
  settleTicket,
  relabel,
  settleRunningTickets,
  startHeartbeat,
  type InstallationTokens,
  type DispatchOutcome,
  type DispatchStart,
  type PullRequestReadiness,
  type PullRequestRef,
  type DispatchTicket,
  type Fetch,
  type TicketState,
} from '@forge/shared';
import {
  maxConcurrentOf,
  repositoryTriggeredBy,
  resolveWorker,
  type RepositoryConfig,
} from './config.ts';
import { gitEnvironment } from './git.ts';
import { SkillNotFound } from './checkout.ts';
import { launchInCheckout } from './checkout-workload.ts';
import { DevShellFailed, nixErrorOf } from './devshell.ts';
import { readRuntimeConfig, stateDirOf, type LaunchResult } from './workload.ts';

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
    : `the forge labels are missing from ${github}, and the frontier sync creates them once it can write to GitHub as the App`;
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

const shortfallOf = ({ draft, failing, pending }: PullRequestReadiness): DispatchOutcome | null => {
  if (draft) return { state: 'failed', reason: 'draft', detail: null };
  if (failing.length > 0) {
    return { state: 'failed', reason: 'check-failed', detail: failing.join(', ') };
  }
  if (pending.length > 0) {
    return { state: 'failed', reason: 'check-pending', detail: pending.join(', ') };
  }
  return null;
};

const outcomeOf = (
  pullRequest: PullRequestRef | null,
  readiness: PullRequestReadiness | null,
  { run, finalMessage, cause }: LaunchResult,
): DispatchOutcome => {
  if (run.status === 'exceeded') {
    return { state: 'failed', reason: 'exceeded', detail: run.exceededLimit };
  }
  if (pullRequest !== null) {
    if (run.status !== 'success') {
      return { state: 'failed', reason: 'errored', detail: run.error };
    }
    return (readiness && shortfallOf(readiness)) ?? { state: 'done', pullRequest };
  }
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

const settleAllRunningTickets = async (
  store: Store,
  repositories: Record<string, RepositoryConfig> | undefined,
  fetch: Fetch,
  tokens: InstallationTokens,
): Promise<void> => {
  for (const [name, { github, on }] of Object.entries(repositories ?? {})) {
    if (on?.ticket === undefined) continue;
    await settleRunningTickets({
      store,
      fetch,
      token: () => tokens(github, 'write'),
      repository: name,
      github,
      now,
      log: (line) => console.error(line),
    });
  }
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
  const repository = repositoryTriggeredBy(config.repositories, name, 'ticket');
  const worker = resolveWorker(config, repository.worker);
  const app = githubAppFromEnv(env, fetch);
  const tokens = cachedTokens(app);
  const unstarted = {
    repository: name,
    number: Number(issue),
    url: `https://github.com/${repository.github}/issues/${issue}`,
  };

  const store = Store.open(join(stateDirOf(env), 'forge.db'));
  try {
    let prepared;
    try {
      const identity = await app.identity(repository.github);
      await settleAllRunningTickets(store, config.repositories, fetch, tokens);

      const ticket = await queryTicket(
        fetch,
        await tokens(repository.github, 'write'),
        repository.github,
        Number(issue),
      );
      const refused = await refusal(
        ticket,
        async () =>
          labelExists(fetch, await tokens(repository.github, 'write'), repository.github, FORGE_READY),
        repository.github,
      );
      if (refused !== null) {
        console.error(`${name}#${ticket.number} is not dispatchable: ${refused}`);
        return 1;
      }

      const writeToken = await tokens(repository.github, 'write');
      const approved = await isApprovedByMaintainer(
        fetch,
        writeToken,
        repository.github,
        ticket.number,
        maintainerLookup(fetch, writeToken, repository.github),
      );
      if (!approved) {
        await refuseTicket(fetch, writeToken, repository.github, ticket.number);
        console.error(`${name}#${ticket.number} is not dispatchable: a maintainer has not approved it`);
        return 1;
      }

      const dispatched = { ...unstarted, url: ticket.url };
      const runId = randomUUID();
      const start = store.startDispatch(dispatched, runId, now(), maxConcurrentOf(config));
      if ('refused' in start) {
        console.error(`${name}#${ticket.number} is not dispatchable: ${startRefusal(start)}`);
        return 1;
      }
      prepared = { identity, ticket, dispatched, runId, dispatchId: start.started };
    } catch (error) {
      store.recordFailedStart(unstarted, errorMessage(error), now());
      throw error;
    }
    const { identity, ticket, dispatched, runId, dispatchId } = prepared;
    const gitEnv = gitEnvironment(env, identity);
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
        await relabel(
          fetch,
          await tokens(repository.github, 'write'),
          repository.github,
          ticket.number,
          FORGE_RUNNING,
          [FORGE_READY],
        );
      } catch (error) {
        return failAs('could not claim the ticket', error);
      }

      let launched: LaunchResult;
      try {
        launched = await launchInCheckout({
          env,
          config,
          worker: {
            ...worker,
            prompt: fillPrompt(worker.prompt, repository.github, ticket),
            promptTemplate: worker.prompt,
          },
          github: repository.github,
          app,
          gitEnv,
          identity,
          ticket: dispatched,
          runId,
        });
      } catch (error) {
        return failAs('could not start the workload', error);
      }

      const afterTokens = cachedTokens(app);
      let pullRequest: PullRequestRef | null;
      let readiness: PullRequestReadiness | null = null;
      try {
        pullRequest = await findOpenClosingPullRequest(
          fetch,
          await afterTokens(repository.github, 'write'),
          repository.github,
          ticket.number,
        );
        if (pullRequest !== null && launched.run.status === 'success') {
          readiness = await queryPullRequestReadiness(
            fetch,
            await afterTokens(repository.github, 'write'),
            repository.github,
            pullRequest.number,
          );
        }
      } catch (error) {
        return failAs('could not check for a pull request', error);
      }

      const outcome = outcomeOf(pullRequest, readiness, launched);
      store.endDispatch(dispatchId, outcome, now());
      await settleTicket(
        fetch,
        await afterTokens(repository.github, 'write'),
        repository.github,
        ticket.number,
        outcome.state,
      );
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
