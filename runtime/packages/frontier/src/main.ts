import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  errorMessage,
  appIdentity,
  ensureLabels,
  installationTokens,
  oldestFirst,
  queryClosed,
  queryFrontier,
  queryPullRequest,
  queryRequests,
  queryWatchedPullRequests,
  reworkOf,
  settleRunningTickets,
  Store,
  type BotIdentity,
  type ClosedTicket,
  type Fetch,
  type InstallationTokens,
  type PullRequestSnapshot,
  type RefinementRequest,
  type Ticket,
  type WatchedPullRequest,
} from '@forge/shared';
import type { FrontierConfig } from './config.ts';

type Poll = (github: string) => Promise<Ticket[]>;

type ClosedPoll = (github: string) => Promise<ClosedTicket[]>;

type RequestPoll = (github: string) => Promise<RefinementRequest[]>;

type PullRequestPoll = (github: string, number: number) => Promise<PullRequestSnapshot>;

type WatchedPoll = (github: string) => Promise<WatchedPullRequest[]>;

const readConfig = (env: NodeJS.ProcessEnv): FrontierConfig => {
  const configPath = env.FORGE_RUNTIME_CONFIG;
  if (configPath === undefined) {
    throw new Error('FORGE_RUNTIME_CONFIG is not set');
  }
  return JSON.parse(readFileSync(configPath, 'utf8')) as FrontierConfig;
};

const polling =
  (tokens: InstallationTokens, fetch: Fetch): Poll =>
  async (github) =>
    queryFrontier(fetch, await tokens(github, 'read'), github);

const closedPolling =
  (tokens: InstallationTokens, fetch: Fetch): ClosedPoll =>
  async (github) =>
    queryClosed(fetch, await tokens(github, 'read'), github);

const requestPolling =
  (tokens: InstallationTokens, fetch: Fetch): RequestPoll =>
  async (github) =>
    queryRequests(fetch, await tokens(github, 'read'), github);

const pullRequestPolling =
  (tokens: InstallationTokens, fetch: Fetch): PullRequestPoll =>
  async (github, number) =>
    queryPullRequest(fetch, await tokens(github, 'read'), github, number);

const BOT_SUFFIX = '[bot]';

const watchedPolling =
  (
    tokens: InstallationTokens,
    fetch: Fetch,
    identity: (github: string) => Promise<{ name: string }>,
  ): WatchedPoll =>
  async (github) => {
    const { name } = await identity(github);
    const login = name.endsWith(BOT_SUFFIX) ? name.slice(0, -BOT_SUFFIX.length) : name;
    return queryWatchedPullRequests(fetch, await tokens(github, 'read'), github, login);
  };

const refreshPullRequests = async (
  store: Store,
  name: string,
  github: string,
  forgeEmail: (github: string) => Promise<string>,
  pullRequest: PullRequestPoll,
): Promise<boolean> => {
  const unsettled = store.unsettledPullRequests(name);
  if (unsettled.length === 0) return true;
  let email: string;
  try {
    email = await forgeEmail(github);
  } catch (error) {
    console.error(`${name}: could not refresh pull requests: ${errorMessage(error)}`);
    return false;
  }
  let refreshed = true;
  for (const { id, number } of unsettled) {
    try {
      const { state, settledAt, commitAuthors } = await pullRequest(github, number);
      store.recordPullRequest(id, {
        state,
        settledAt,
        rework: reworkOf(commitAuthors, email),
      });
    } catch (error) {
      console.error(`${name}: could not refresh pull request #${number}: ${errorMessage(error)}`);
      refreshed = false;
    }
  }
  return refreshed;
};

interface GithubWrites {
  ensure: (github: string) => Promise<void>;
  settle: (store: Store, repository: string, github: string) => Promise<boolean>;
}

const githubWrites = (
  config: FrontierConfig,
  tokens: InstallationTokens,
  fetch: Fetch,
): GithubWrites | null =>
  Object.values(config.repositories).every(({ on }) => on?.ticket === undefined)
    ? null
    : {
        ensure: async (github) => ensureLabels(fetch, await tokens(github, 'write'), github),
        settle: (store, repository, github) =>
          settleRunningTickets({
            store,
            fetch,
            token: () => tokens(github, 'write'),
            repository,
            github,
            now: () => new Date().toISOString(),
            log: (line) => console.error(line),
          }),
      };

const sync = async (
  config: FrontierConfig,
  env: NodeJS.ProcessEnv,
  poll: Poll,
  pollClosed: ClosedPoll,
  pollRequests: RequestPoll,
  pullRequest: PullRequestPoll,
  forgeEmail: (github: string) => Promise<string>,
  watched: WatchedPoll,
  writes: GithubWrites | null,
): Promise<number> => {
  const stateDir = env.FORGE_STATE_DIR;
  if (stateDir === undefined) {
    throw new Error('FORGE_STATE_DIR is not set');
  }
  const store = Store.open(join(stateDir, 'forge.db'));

  try {
    store.pruneFrontier(Object.keys(config.repositories));
    let failed = false;
    for (const [name, { github, on }] of Object.entries(config.repositories)) {
      try {
        const tickets = await poll(github);
        const closed = await pollClosed(github);
        const requests = await pollRequests(github);
        store.replaceFrontier({
          repository: name,
          github,
          polledAt: new Date().toISOString(),
          tickets,
          closed,
          requests,
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
      if (
        !(await refreshPullRequests(
          store,
          name,
          github,
          forgeEmail,
          pullRequest,
        ))
      ) {
        failed = true;
      }
      if (on?.feedback !== undefined || on?.conflict !== undefined) {
        try {
          store.recordWatchedPullRequests(name, await watched(github));
        } catch (error) {
          console.error(`${name}: could not poll watched pull requests: ${errorMessage(error)}`);
          failed = true;
        }
      }
      if (writes === null) continue;
      try {
        await writes.ensure(github);
      } catch (error) {
        console.error(`${name}: could not ensure the forge labels: ${errorMessage(error)}`);
        failed = true;
      }
      if (on?.ticket !== undefined && !(await writes.settle(store, name, github))) {
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

const describeFrontier = (tickets: Ticket[]): string[] => {
  const frontier = tickets.filter((ticket) => !ticket.blocked && !ticket.forHuman);
  return frontier.length === 0
    ? ['  no tickets on the frontier']
    : frontier.toSorted(oldestFirst).flatMap(describeTicket);
};

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
  const tokens = installationTokens(env, fetch);
  const poll = polling(tokens, fetch);
  const identities = new Map<string, Promise<BotIdentity>>();
  const identity = (github: string): Promise<BotIdentity> => {
    const known = identities.get(github);
    if (known !== undefined) return known;
    const fetched = appIdentity(env, fetch, github);
    identities.set(github, fetched);
    return fetched;
  };
  return command === 'sync'
    ? sync(
        config,
        env,
        poll,
        closedPolling(tokens, fetch),
        requestPolling(tokens, fetch),
        pullRequestPolling(tokens, fetch),
        async (github) => (await identity(github)).email,
        watchedPolling(tokens, fetch, identity),
        githubWrites(config, tokens, fetch),
      )
    : list(config, poll);
};

if (import.meta.filename === process.argv[1]) {
  main(process.argv.slice(2), process.env, globalThis.fetch)
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(errorMessage(error));
      process.exit(1);
    });
}
