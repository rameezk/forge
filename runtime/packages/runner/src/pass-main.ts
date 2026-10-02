import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { errorMessage, oldestFirst, Store, type Ticket } from '@forge/shared';
import { maxConcurrentOf, type RuntimeConfig } from './config.ts';
import { absolutePath, readRuntimeConfig, stateDirOf } from './workload.ts';

const run = promisify(execFile);

const USAGE = 'usage: forge-dispatch-pass';

interface Dispatchable extends Ticket {
  repository: string;
}

const ticketKey = (repository: string, number: number): string => `${repository}#${number}`;

const declaresWorker = ({ repositories = {} }: RuntimeConfig, name: string): boolean =>
  Object.hasOwn(repositories, name) && repositories[name]?.worker !== undefined;

const dispatchable = (
  config: RuntimeConfig,
  store: Store,
  running: ReadonlySet<string>,
): Dispatchable[] =>
  store
    .listFrontier()
    .filter(({ repository }) => declaresWorker(config, repository))
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

const unitOf = ({ repository, number }: Dispatchable): string =>
  `forge-dispatch@${repository}:${number}.service`;

export const main = async (argv: string[], env: NodeJS.ProcessEnv): Promise<number> => {
  if (argv.length > 0) throw new Error(USAGE);
  const config = readRuntimeConfig(env);
  const systemctl = absolutePath(env, 'FORGE_SYSTEMCTL');
  const maxConcurrent = maxConcurrentOf(config);
  const store = Store.open(join(stateDirOf(env), 'forge.db'));
  let running: Set<string>;
  let candidates: Dispatchable[];
  try {
    running = new Set(
      store
        .listDispatches(new Date().toISOString())
        .filter(({ state }) => state === 'running')
        .map(({ repository, number }) => ticketKey(repository, number)),
    );
    candidates = dispatchable(config, store, running);
  } finally {
    store.close();
  }

  const slots = Math.max(0, maxConcurrent - running.size);
  for (const { repository, number } of candidates.slice(slots)) {
    console.error(
      `${repository}#${number}: waits, ${maxConcurrent} of ${maxConcurrent} dispatched workloads would be running`,
    );
  }

  let failed = false;
  for (const ticket of candidates.slice(0, slots)) {
    const unit = unitOf(ticket);
    try {
      await run(systemctl, ['start', '--no-block', '--no-ask-password', '--', unit], { env });
      console.error(`${ticket.repository}#${ticket.number}: started ${unit}`);
    } catch (error) {
      console.error(`${ticket.repository}#${ticket.number}: could not start ${unit}: ${errorMessage(error)}`);
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
