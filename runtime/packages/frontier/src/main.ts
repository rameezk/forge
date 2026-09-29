import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  oldestFirst,
  queryFrontier,
  Store,
  type Fetch,
  type Ticket,
} from '@forge/shared';
import type { FrontierConfig } from './config.ts';

type Poll = (github: string) => Promise<Ticket[]>;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const readConfig = (env: NodeJS.ProcessEnv): FrontierConfig => {
  const configPath = env.FORGE_RUNTIME_CONFIG;
  if (configPath === undefined) {
    throw new Error('FORGE_RUNTIME_CONFIG is not set');
  }
  return JSON.parse(readFileSync(configPath, 'utf8')) as FrontierConfig;
};

const failing =
  (message: string): Poll =>
  () =>
    Promise.reject(new Error(message));

const polling = (env: NodeJS.ProcessEnv, fetch: Fetch): Poll => {
  const token = env.GITHUB_TOKEN?.trim() ?? '';
  if (token === '') return failing('GitHub token missing');
  if (!/^[\x21-\x7e]+$/.test(token)) return failing('GitHub token malformed');
  return (github) => queryFrontier(fetch, token, github);
};

const sync = async (
  config: FrontierConfig,
  env: NodeJS.ProcessEnv,
  poll: Poll,
): Promise<number> => {
  const stateDir = env.FORGE_STATE_DIR;
  if (stateDir === undefined) {
    throw new Error('FORGE_STATE_DIR is not set');
  }
  const store = Store.open(join(stateDir, 'forge.db'));

  try {
    store.pruneFrontier(Object.keys(config.repositories));
    let failed = false;
    for (const [name, { github }] of Object.entries(config.repositories)) {
      try {
        const tickets = await poll(github);
        store.replaceFrontier({
          repository: name,
          github,
          polledAt: new Date().toISOString(),
          tickets,
        });
      } catch (error) {
        const message = errorMessage(error);
        console.error(`${name}: ${message}`);
        store.recordFrontierError({
          repository: name,
          github,
          message,
          failedAt: new Date().toISOString(),
        });
        failed = true;
      }
    }
    return failed ? 1 : 0;
  } finally {
    store.close();
  }
};

const printable = (line: string): string =>
  line.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '');

const describeTicket = (ticket: Ticket): string[] => {
  const created = `created ${ticket.createdAt.slice(0, 10)}`;
  const spec =
    ticket.parent === null
      ? `no parent spec, ${created}`
      : `spec #${ticket.parent.number} ${ticket.parent.title}, ${created}`;
  return [
    `  #${ticket.number} ${ticket.title}`,
    `      ${ticket.url}`,
    `      ${spec}`,
  ];
};

const describeFrontier = (tickets: Ticket[]): string[] =>
  tickets.length === 0
    ? ['  no tickets on the frontier']
    : tickets.toSorted(oldestFirst).flatMap(describeTicket);

const list = async (config: FrontierConfig, poll: Poll): Promise<number> => {
  const groups: string[] = [];
  let failed = false;
  for (const [name, { github }] of Object.entries(config.repositories)) {
    let lines: string[];
    try {
      lines = describeFrontier(await poll(github));
    } catch (error) {
      lines = [`  error: ${errorMessage(error)}`];
      failed = true;
    }
    groups.push([`${name} (${github})`, ...lines].map(printable).join('\n'));
  }
  console.log(groups.join('\n\n'));
  return failed ? 1 : 0;
};

export const main = async (
  argv: string[],
  env: NodeJS.ProcessEnv,
  fetch: Fetch,
): Promise<number> => {
  const command = argv[0];
  if (command !== 'sync' && command !== 'list') {
    throw new Error('usage: forge-frontier sync|list');
  }
  const config = readConfig(env);
  const poll = polling(env, fetch);
  return command === 'sync' ? sync(config, env, poll) : list(config, poll);
};

if (import.meta.filename === process.argv[1]) {
  main(process.argv.slice(2), process.env, globalThis.fetch)
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(errorMessage(error));
      process.exit(1);
    });
}
