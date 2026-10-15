import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  errorMessage,
  oldestFirst,
  Store,
  ticketKey,
  type RevisedPullRequest,
  type Ticket,
} from '@forge/shared';
import { maxConcurrentOf, quietPeriodOf, type RuntimeConfig } from './config.ts';
import { absolutePath, readRuntimeConfig, stateDirOf } from './workload.ts';

const run = promisify(execFile);

const USAGE = 'usage: forge-dispatch-pass';

interface Dispatchable extends Ticket {
  repository: string;
}

const declaresTicketWorker = ({ repositories = {} }: RuntimeConfig, name: string): boolean =>
  Object.hasOwn(repositories, name) && repositories[name]?.on?.ticket !== undefined;

const declaresFeedbackWorker = ({ repositories = {} }: RuntimeConfig, name: string): boolean =>
  Object.hasOwn(repositories, name) && repositories[name]?.on?.feedback !== undefined;

const dispatchable = (
  config: RuntimeConfig,
  store: Store,
  running: ReadonlySet<string>,
): Dispatchable[] =>
  store
    .listFrontier()
    .filter(({ repository, lastError }) => lastError === null && declaresTicketWorker(config, repository))
    .flatMap(({ repository, tickets }) =>
      tickets
        .filter(
          (ticket) =>
            ticket.forgeReady &&
            !ticket.blocked &&
            !running.has(ticketKey(repository, ticket.number)),
        )
        .map((ticket) => ({ ...ticket, repository })),
    )
    .toSorted(oldestFirst);

type Pending =
  | ({ kind: 'dispatch' } & Dispatchable)
  | ({ kind: 'revision' } & RevisedPullRequest);

const unitOf = (pending: Pending): string =>
  `forge-${pending.kind === 'dispatch' ? 'dispatch' : 'revise'}@${pending.repository}:${pending.number}.service`;

export const main = async (argv: string[], env: NodeJS.ProcessEnv): Promise<number> => {
  if (argv.length > 0) throw new Error(USAGE);
  const config = readRuntimeConfig(env);
  const systemctl = absolutePath(env, 'FORGE_SYSTEMCTL');
  const maxConcurrent = maxConcurrentOf(config);
  const store = Store.open(join(stateDirOf(env), 'forge.db'));
  let running: Set<string>;
  let live: number;
  let candidates: Pending[];
  try {
    const now = new Date().toISOString();
    running = new Set(
      store
        .listDispatches(now)
        .filter(({ state }) => state === 'running')
        .map(({ repository, number }) => ticketKey(repository, number)),
    );
    live = store.liveWorkloads(now);
    candidates = [
      ...store
        .feedbackDue(now, quietPeriodOf(config))
        .filter(({ repository }) => declaresFeedbackWorker(config, repository))
        .map((pull): Pending => ({ kind: 'revision', ...pull })),
      ...dispatchable(config, store, running).map((ticket): Pending => ({ kind: 'dispatch', ...ticket })),
    ];
  } finally {
    store.close();
  }

  const slots = Math.max(0, maxConcurrent - live);
  for (const { repository, number } of candidates.slice(slots)) {
    console.error(
      `${repository}#${number}: waits, ${maxConcurrent} of ${maxConcurrent} workloads would be running`,
    );
  }

  let failed = false;
  for (const pending of candidates.slice(0, slots)) {
    const unit = unitOf(pending);
    try {
      await run(systemctl, ['start', '--no-block', '--no-ask-password', '--', unit], { env });
      console.error(`${pending.repository}#${pending.number}: started ${unit}`);
    } catch (error) {
      console.error(`${pending.repository}#${pending.number}: could not start ${unit}: ${errorMessage(error)}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
};

if (import.meta.filename === process.argv[1]) {
  main(process.argv.slice(2), process.env)
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(errorMessage(error));
      process.exit(1);
    });
}
