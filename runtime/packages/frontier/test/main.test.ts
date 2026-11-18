import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GITHUB_GRAPHQL_API, Store } from '@forge/shared';
import type { PolledFrontier, Ticket } from '@forge/shared';
import { main } from '../src/main.ts';
import {
  APP_ID,
  BOT_EMAIL,
  fakeGithubApp,
  routedThrough,
  tokenFor,
  type FakeGithubApp,
} from '../../shared/test/fixtures/fake-github-app.ts';
import { withProtectedRepositories } from '../../shared/test/fixtures/branch-rules.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'github');

interface RecordedPage {
  data?: {
    repository: {
      issues: {
        pageInfo: { hasNextPage?: boolean; endCursor: string | null };
        nodes: Record<string, unknown>[];
      };
    } | null;
  };
}

const recorded = (name: string): RecordedPage[] =>
  JSON.parse(
    readFileSync(join(FIXTURES, `${name}.json`), 'utf8'),
  ) as RecordedPage[];

const endCursor = (page: RecordedPage | undefined): string | null | undefined =>
  page?.data?.repository?.issues.pageInfo.endCursor;

const GITHUB_TOKEN = tokenFor('read', 'rameezk/forge');

interface Request {
  url: string;
  method: string | undefined;
  authorization: string | null;
  body: { query: string; variables: Record<string, string | number | null> };
}

const replaying = (
  responses: Record<string, RecordedPage[]>,
  refinement: Record<string, RecordedPage[]> = {},
  human: Record<string, RecordedPage[]> = {},
  closed: Record<string, RecordedPage[]> = {},
) => {
  const requests: Request[] = [];
  const fetch = async (
    input: string | URL | globalThis.Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as Request['body'];
    requests.push({
      url: String(input),
      method: init?.method,
      authorization: new Headers(init?.headers).get('authorization'),
      body,
    });
    const github = `${body.variables.owner}/${body.variables.name}`;
    const pages =
      body.variables.since !== undefined
        ? (closed[`${github}:${String(body.variables.label)}`] ?? recorded('no-issues'))
        : body.variables.label === 'ready-for-refinement'
        ? (refinement[github] ?? recorded('no-issues'))
        : body.variables.label === 'ready-for-human'
          ? (human[github] ?? recorded('no-issues'))
          : responses[github];
    const after = body.variables.after;
    const response = pages?.find((_, index) =>
      index === 0 ? after === null : endCursor(pages[index - 1]) === after,
    );
    if (response === undefined) {
      throw new Error(
        `no recorded response for ${github} after ${String(after)}`,
      );
    }
    return new Response(JSON.stringify(response), {
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, requests };
};

const declaring = (
  repositories: Record<string, { github: string; on?: { ticket?: string }; autoApprove?: boolean }>,
  notInstalled: string[] = [],
) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'forge-frontier-'));
  const configPath = join(stateDir, 'runtime.json');
  const app = fakeGithubApp(
    Object.values(repositories)
      .map(({ github }) => github)
      .filter((github) => !notInstalled.includes(github)),
  );
  const keyPath = join(stateDir, 'github-app-private-key');
  writeFileSync(keyPath, app.privateKey);
  writeFileSync(
    configPath,
    JSON.stringify({
      harnesses: {},
      workers: {},
      repositories,
    }),
  );
  return {
    stateDir,
    app,
    env: {
      FORGE_RUNTIME_CONFIG: configPath,
      FORGE_STATE_DIR: stateDir,
      FORGE_GITHUB_APP_ID: APP_ID,
      FORGE_GITHUB_APP_PRIVATE_KEY_FILE: keyPath,
    } as Record<string, string | undefined>,
  };
};

const run = (
  app: FakeGithubApp,
  argv: string[],
  env: Record<string, string | undefined>,
  fetch: typeof globalThis.fetch,
): Promise<number> => main(argv, env, routedThrough(app, withProtectedRepositories(fetch)));

const storedFrontier = (stateDir: string) => {
  const store = Store.open(join(stateDir, 'forge.db'));
  try {
    return store.listFrontier();
  } finally {
    store.close();
  }
};

test('given a declared repository whose recorded response holds unblocked ready-for-agent issues and a blocked one labelled forge:ready, when sync runs, then the store holds the unblocked tickets, the blocked one as queued, which are labelled forge:ready, and when the repository was polled', async () => {
  const { stateDir, env, app } = declaring({ forge: { github: 'rameezk/forge' } });
  const github = replaying({ 'rameezk/forge': recorded('frontier') });

  const before = new Date().toISOString();
  const code = await run(app, ['sync'], env, github.fetch);
  const after = new Date().toISOString();

  assert.equal(code, 0);
  const [forge, ...others] = storedFrontier(stateDir);
  assert.deepEqual(others, []);
  assert.ok(forge);
  assert.equal(forge.repository, 'forge');
  assert.equal(forge.github, 'rameezk/forge');
  assert.equal(forge.lastError, null);
  assert.ok(
    forge.polledAt !== null &&
      before <= forge.polledAt &&
      forge.polledAt <= after,
  );
  assert.deepEqual(
    forge.tickets.map(({ number, forgeReady, blocked }) => ({ number, forgeReady, blocked })),
    [
      { number: 57, forgeReady: false, blocked: false },
      { number: 58, forgeReady: false, blocked: false },
      { number: 62, forgeReady: false, blocked: false },
      { number: 63, forgeReady: false, blocked: false },
      { number: 64, forgeReady: true, blocked: true },
      { number: 69, forgeReady: true, blocked: false },
      { number: 70, forgeReady: false, blocked: false },
    ],
  );
  assert.deepEqual(forge.tickets[0], {
    number: 57,
    title: 'Frontier sync survives real-world GitHub',
    url: 'https://github.com/rameezk/forge/issues/57',
    parent: {
      number: 54,
      title: 'Frontier discovery across managed repositories',
      url: 'https://github.com/rameezk/forge/issues/54',
    },
    createdAt: '2026-09-28T10:08:01Z',
    forgeReady: false,
    blocked: false,
    forHuman: false,
    blockedBy: [],
  });
  const since = github.requests[2]?.body.variables.since;
  assert.equal(typeof since, 'string');
  assert.ok(Math.abs(Date.parse(String(since)) - (Date.now() - 7 * 86_400_000)) < 60_000);
  assert.deepEqual(
    github.requests.map(({ url, method, authorization, body }) => ({
      url,
      method,
      authorization,
      variables: body.variables,
    })),
    [
      {
        url: GITHUB_GRAPHQL_API,
        method: 'POST',
        authorization: `bearer ${GITHUB_TOKEN}`,
        variables: { owner: 'rameezk', name: 'forge', label: 'ready-for-agent', first: 100, after: null },
      },
      {
        url: GITHUB_GRAPHQL_API,
        method: 'POST',
        authorization: `bearer ${GITHUB_TOKEN}`,
        variables: { owner: 'rameezk', name: 'forge', label: 'ready-for-human', first: 100, after: null },
      },
      ...['ready-for-agent', 'ready-for-human'].map((label) => ({
        url: GITHUB_GRAPHQL_API,
        method: 'POST',
        authorization: `bearer ${GITHUB_TOKEN}`,
        variables: { owner: 'rameezk', name: 'forge', label, since, first: 100, after: null },
      })),
      {
        url: GITHUB_GRAPHQL_API,
        method: 'POST',
        authorization: `bearer ${GITHUB_TOKEN}`,
        variables: { owner: 'rameezk', name: 'forge', label: 'ready-for-refinement', first: 100, after: null },
      },
    ],
  );
});

test('given a repository with a blocked ready-for-agent ticket, a blocked forge:ready ticket and a blocked ready-for-human ticket, when sync runs, then all three are stored as blocked with their open blockers, and only the forge:ready one is queued', async () => {
  const { stateDir, env, app } = declaring({ forge: { github: 'rameezk/forge' } });
  const github = replaying(
    { 'rameezk/forge': recorded('blocked-agent') },
    {},
    { 'rameezk/forge': recorded('ready-for-human') },
  );

  const code = await run(app, ['sync'], env, github.fetch);

  assert.equal(code, 0);
  assert.deepEqual(
    storedFrontier(stateDir)[0]?.tickets.map(({ number, blocked, blockedBy, forgeReady, forHuman }) => ({
      number,
      blocked,
      blockedBy,
      forgeReady,
      forHuman,
    })),
    [
      { number: 201, blocked: true, blockedBy: [200], forgeReady: false, forHuman: false },
      { number: 202, blocked: true, blockedBy: [200, 199], forgeReady: true, forHuman: false },
      { number: 203, blocked: true, blockedBy: [200], forgeReady: false, forHuman: true },
      { number: 204, blocked: false, blockedBy: [], forgeReady: false, forHuman: true },
    ],
  );
});

const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

const closedPage = (nodes: Record<string, unknown>[]): RecordedPage[] => [
  { data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: 'end' }, nodes } } } },
];

const closedIssue = (number: number, closedAt: string, labels: string[]): Record<string, unknown> => ({
  number,
  title: `Closed ticket ${number}`,
  url: `https://github.com/rameezk/forge/issues/${number}`,
  createdAt: '2026-09-01T10:00:00Z',
  closedAt,
  labels: { nodes: labels.map((name) => ({ name })) },
  parent: null,
});

test('given tickets closed 2 days ago and 9 days ago, one labelled ready-for-human, when sync runs, then only the ticket closed 2 days ago is stored as closed, with its closing time and whether a human built it', async () => {
  const { stateDir, env, app } = declaring({ forge: { github: 'rameezk/forge' } });
  const recent = daysAgo(2);
  const github = replaying(
    { 'rameezk/forge': recorded('no-issues') },
    {},
    {},
    {
      'rameezk/forge:ready-for-agent': closedPage([closedIssue(301, daysAgo(9), ['ready-for-agent'])]),
      'rameezk/forge:ready-for-human': closedPage([
        closedIssue(302, recent, ['ready-for-human']),
        closedIssue(303, daysAgo(9), ['ready-for-human']),
      ]),
    },
  );

  const code = await run(app, ['sync'], env, github.fetch);

  assert.equal(code, 0);
  assert.deepEqual(
    storedFrontier(stateDir)[0]?.closed.map(({ number, closedAt, forHuman }) => ({ number, closedAt, forHuman })),
    [{ number: 302, closedAt: recent, forHuman: true }],
  );
});

test('given a declared repository with open issues labelled ready-for-refinement, when sync runs, then the store holds them as its requests with their number, title, link and created date', async () => {
  const { stateDir, env, app } = declaring({ forge: { github: 'rameezk/forge' } });
  const github = replaying({ 'rameezk/forge': recorded('frontier') }, { 'rameezk/forge': recorded('requests') });

  const code = await run(app, ['sync'], env, github.fetch);

  assert.equal(code, 0);
  assert.deepEqual(storedFrontier(stateDir)[0]?.requests, [
    {
      number: 146,
      title: 'Give each forge unit only the state directory access it needs',
      url: 'https://github.com/rameezk/forge/issues/146',
      createdAt: '2026-10-01T06:17:03Z',
    },
    {
      number: 164,
      title: 'Keep a sandboxed workload from reading forge state through the dashboard',
      url: 'https://github.com/rameezk/forge/issues/164',
      createdAt: '2026-10-01T12:35:20Z',
    },
    {
      number: 166,
      title: 'Bound how long a workload run may take',
      url: 'https://github.com/rameezk/forge/issues/166',
      createdAt: '2026-10-01T12:52:46Z',
    },
  ]);
});

const FORGE_LABELS = [
  { name: 'forge:ready', color: '1d76db', description: 'Queued for forge: an agent picks it up once it is on the frontier' },
  { name: 'forge:running', color: 'fbca04', description: 'Forge is running an agent on this ticket' },
  { name: 'forge:done', color: '0e8a16', description: 'Forge left a ready pull request with green required checks closing this ticket' },
  { name: 'forge:failed', color: 'd93f0b', description: 'Not a ready pull request with green required checks; see the dashboard, label forge:ready to retry' },
];

const STATUS_LABELS = [
  { name: 'ready-for-refinement', color: 'd4c5f9', description: 'Waiting for refinement: the spec is not settled yet' },
  { name: 'ready-for-human', color: 'f9d0c4', description: 'Ready, but needs a human to build it' },
  { name: 'ready-for-agent', color: 'c2e0c6', description: 'Ready for an agent to build' },
];

const WRITE_TOKEN = tokenFor('write', 'rameezk/forge');

interface LabelCall {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

const recordedLabel = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(join(FIXTURES, `${name}.json`), 'utf8'),
  ) as Record<string, unknown>;

const labelling = (
  graphql: ReturnType<typeof replaying>,
  existing: Record<string, { color: string; description: string }>,
) => {
  const calls: LabelCall[] = [];
  const fetch = async (
    input: string | URL | globalThis.Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname === '/graphql') return graphql.fetch(input, init);
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      path: url.pathname,
      authorization: new Headers(init?.headers).get('authorization'),
      body: init?.body === undefined ? null : JSON.parse(String(init.body)),
    });
    const name = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
    const label = existing[name];
    if (method === 'GET') {
      return label === undefined
        ? new Response(JSON.stringify(recordedLabel('label-missing')), { status: 404 })
        : new Response(JSON.stringify({ ...recordedLabel('label'), name, ...label }));
    }
    return new Response(JSON.stringify(recordedLabel('label')), {
      status: method === 'POST' ? 201 : 200,
    });
  };
  return { fetch, calls };
};

test('given a declared repository missing two forge labels and ready-for-agent and holding stale forge:running and grey ready-for-refinement, when sync runs on a host that dispatches, then all four forge labels and the three status labels exist with their fixed descriptions and colours, written with a write token scoped to that repository alone', async () => {
  const { stateDir, env, app } = declaring({ forge: { github: 'rameezk/forge', on: { ticket: 'builder' } } });
  const [ready, running, done, failed] = FORGE_LABELS;
  const [refinement, human, agent] = STATUS_LABELS;
  assert.ok(ready && running && done && failed && refinement && human && agent);
  const github = labelling(runningIssues(replaying({ 'rameezk/forge': recorded('frontier') }), []), {
    'forge:running': { color: 'ededed', description: running.description },
    'forge:done': { color: done.color.toUpperCase(), description: done.description },
    'ready-for-refinement': { color: 'ededed', description: '' },
    'ready-for-human': { color: human.color, description: human.description },
  });

  const code = await run(app, 
    ['sync'],
    env,
    github.fetch,
  );

  assert.equal(code, 0);
  assert.equal(storedFrontier(stateDir)[0]?.tickets.length, 7);
  assert.deepEqual(
    github.calls.filter(({ method }) => method !== 'GET'),
    [
      { method: 'POST', path: '/repos/rameezk/forge/labels', authorization: `bearer ${WRITE_TOKEN}`, body: ready },
      {
        method: 'PATCH',
        path: '/repos/rameezk/forge/labels/forge%3Arunning',
        authorization: `bearer ${WRITE_TOKEN}`,
        body: { color: running.color, description: running.description },
      },
      { method: 'POST', path: '/repos/rameezk/forge/labels', authorization: `bearer ${WRITE_TOKEN}`, body: failed },
      {
        method: 'PATCH',
        path: '/repos/rameezk/forge/labels/ready-for-refinement',
        authorization: `bearer ${WRITE_TOKEN}`,
        body: { color: refinement.color, description: refinement.description },
      },
      { method: 'POST', path: '/repos/rameezk/forge/labels', authorization: `bearer ${WRITE_TOKEN}`, body: agent },
    ],
  );
  assert.ok(github.calls.every(({ authorization }) => authorization === `bearer ${WRITE_TOKEN}`));
  assert.deepEqual(
    app.mints.map(({ kind, body }) => ({ kind, repositories: body.repositories })),
    [
      { kind: 'read', repositories: ['forge'] },
      { kind: 'administration', repositories: ['forge'] },
      { kind: 'write', repositories: ['forge'] },
    ],
  );
});

test('given a declared repository with all seven labels already styled as forge defines them, when sync runs on a host that dispatches, then no label is written', async () => {
  const { env, app } = declaring({ forge: { github: 'rameezk/forge', on: { ticket: 'builder' } } });
  const github = labelling(
    runningIssues(replaying({ 'rameezk/forge': recorded('frontier') }), []),
    allForgeLabels,
  );

  const code = await run(app, ['sync'], env, github.fetch);

  assert.equal(code, 0);
  assert.deepEqual(github.calls.filter(({ method }) => method !== 'GET'), []);
});

test('given a declared repository whose recorded response spans several pages, when sync runs, then tickets from every page are stored, blocked ones included', async () => {
  const { stateDir, env, app } = declaring({ forge: { github: 'rameezk/forge' } });
  const pages = recorded('frontier-paged');
  const github = replaying({ 'rameezk/forge': pages });

  const code = await run(app, ['sync'], env, github.fetch);

  assert.equal(code, 0);
  const [forge] = storedFrontier(stateDir);
  assert.deepEqual(
    forge?.tickets.map((ticket) => ticket.number),
    [57, 58, 62, 63, 64, 69, 70],
  );
  assert.deepEqual(
    github.requests.filter(({ body }) => body.variables.label === 'ready-for-agent' && body.variables.since === undefined).map(({ body }) => body.variables.after),
    [null, ...pages.slice(0, 2).map(endCursor)],
  );
});

const seeding = (stateDir: string, frontier: PolledFrontier[]) => {
  const store = Store.open(join(stateDir, 'forge.db'));
  try {
    for (const repository of frontier) store.replaceFrontier(repository);
  } finally {
    store.close();
  }
};

const staleTicket = (github: string, number: number): Ticket => ({
  number,
  title: `Stale ticket ${number}`,
  url: `https://github.com/${github}/issues/${number}`,
  parent: null,
  createdAt: '2026-09-01T09:00:00Z',
  forgeReady: false,
  blocked: false,
  forHuman: false,
  blockedBy: [],
});

test('given two declared repositories with stored snapshots where GitHub now fails for one, when sync runs, then the healthy snapshot is replaced and the failing one keeps its previous tickets and polled time with the error as its last error', async () => {
  const { stateDir, env, app } = declaring({
    forge: { github: 'rameezk/forge' },
    gone: { github: 'rameezk/forge-does-not-exist' },
  });
  const previousPoll = '2026-09-29T08:00:00.000Z';
  seeding(stateDir, [
    {
      repository: 'forge',
      github: 'rameezk/forge',
      polledAt: previousPoll,
      closed: [], requests: [],
      tickets: [staleTicket('rameezk/forge', 1)],
    },
    {
      repository: 'gone',
      github: 'rameezk/forge-does-not-exist',
      polledAt: previousPoll,
      closed: [], requests: [],
      tickets: [staleTicket('rameezk/forge-does-not-exist', 2)],
    },
  ]);
  const github = replaying({
    'rameezk/forge': recorded('frontier'),
    'rameezk/forge-does-not-exist': recorded('not-found'),
  });

  const before = new Date().toISOString();
  const code = await run(app, ['sync'], env, github.fetch);
  const after = new Date().toISOString();

  assert.notEqual(code, 0);
  const [forge, gone] = storedFrontier(stateDir);
  assert.deepEqual(
    forge?.tickets.map((ticket) => ticket.number),
    [57, 58, 62, 63, 64, 69, 70],
  );
  assert.ok(forge && forge.polledAt !== previousPoll);
  assert.equal(forge.lastError, null);
  const failedAt = gone?.lastError?.failedAt ?? '';
  assert.ok(before <= failedAt && failedAt <= after);
  assert.deepEqual(gone, {
    repository: 'gone',
    github: 'rameezk/forge-does-not-exist',
    polledAt: previousPoll,
    lastError: {
      message:
        "GitHub rejected the Frontier query for rameezk/forge-does-not-exist: Could not resolve to a Repository with the name 'rameezk/forge-does-not-exist'.",
      failedAt,
    },
    branchRules: [],
    closed: [], requests: [],
    tickets: [staleTicket('rameezk/forge-does-not-exist', 2)],
  });
});

const MISSING_APP = [
  ['no App id', 'GitHub App id missing', () => ({ FORGE_GITHUB_APP_ID: undefined })],
  [
    'no private key file',
    'GitHub App private key missing',
    () => ({ FORGE_GITHUB_APP_PRIVATE_KEY_FILE: undefined }),
  ],
  [
    'an empty private key file',
    'GitHub App private key missing',
    (stateDir: string) => {
      const path = join(stateDir, 'empty-private-key');
      writeFileSync(path, '');
      return { FORGE_GITHUB_APP_PRIVATE_KEY_FILE: path };
    },
  ],
] as const;

for (const [absence, message, override] of MISSING_APP) {
  test(`given ${absence}, when sync runs, then every declared repository records the missing App credential, no GitHub request is made and the exit code is non-zero`, async () => {
    const { stateDir, env, app } = declaring({
      forge: { github: 'rameezk/forge' },
      fresh: { github: 'rameezk/fresh' },
    });
    const previousPoll = '2026-09-29T08:00:00.000Z';
    seeding(stateDir, [
      {
        repository: 'forge',
        github: 'rameezk/forge',
        polledAt: previousPoll,
        closed: [], requests: [],
        tickets: [staleTicket('rameezk/forge', 1)],
      },
    ]);
    const github = replaying({ 'rameezk/forge': recorded('frontier') });

    const code = await run(app, 
      ['sync'],
      { ...env, ...override(stateDir) },
      github.fetch,
    );

    assert.notEqual(code, 0);
    assert.deepEqual(github.requests, []);
    const stored = storedFrontier(stateDir);
    assert.deepEqual(
      stored.map(({ lastError }) => lastError?.message),
      [message, message],
    );
    assert.deepEqual(
      stored.map(({ repository, polledAt, tickets }) => ({
        repository,
        polledAt,
        tickets,
      })),
      [
        {
          repository: 'forge',
          polledAt: previousPoll,
          tickets: [staleTicket('rameezk/forge', 1)],
        },
        { repository: 'fresh', polledAt: null, tickets: [] },
      ],
    );
  });
}

test('given stored rows for a repository no longer declared, when sync runs, then those rows are gone', async () => {
  const { stateDir, env, app } = declaring({ forge: { github: 'rameezk/forge' } });
  seeding(stateDir, [
    {
      repository: 'retired',
      github: 'rameezk/retired',
      polledAt: '2026-09-29T08:00:00.000Z',
      closed: [], requests: [],
      tickets: [staleTicket('rameezk/retired', 3)],
    },
  ]);
  const github = replaying({ 'rameezk/forge': recorded('frontier') });

  const code = await run(app, ['sync'], env, github.fetch);

  assert.equal(code, 0);
  assert.deepEqual(
    storedFrontier(stateDir).map(({ repository }) => repository),
    ['forge'],
  );
  const db = new DatabaseSync(join(stateDir, 'forge.db'));
  try {
    assert.deepEqual(
      db
        .prepare(
          "SELECT number FROM frontier_tickets WHERE repository = 'retired'",
        )
        .all(),
      [],
    );
  } finally {
    db.close();
  }
});

test('given a repository whose paging never advances past its first cursor, when sync runs, then it records the stalled paging as its error instead of polling forever', async () => {
  const { stateDir, env, app } = declaring({ forge: { github: 'rameezk/forge' } });
  const [first] = recorded('frontier-paged');
  assert.ok(first);
  const github = replaying({ 'rameezk/forge': [first, first] });

  const code = await run(app, ['sync'], env, github.fetch);

  assert.notEqual(code, 0);
  assert.equal(github.requests.length, 2);
  const [forge] = storedFrontier(stateDir);
  assert.equal(
    forge?.lastError?.message,
    'GitHub paging did not advance for rameezk/forge',
  );
  assert.deepEqual(forge?.tickets, []);
});

const printing = (t: TestContext) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  t.mock.method(console, 'log', (line: string) => stdout.push(line));
  t.mock.method(console, 'error', (line: string) => stderr.push(line));
  return { stdout: () => stdout.join('\n'), stderr: () => stderr.join('\n') };
};

const reshaped = (
  name: string,
  reshape: (nodes: Record<string, unknown>[]) => Record<string, unknown>[],
): RecordedPage[] =>
  recorded(name).map((page) => {
    const issues = page.data?.repository?.issues;
    assert.ok(issues);
    return {
      data: {
        repository: { issues: { ...issues, nodes: reshape(issues.nodes) } },
      },
    };
  });

test('given declared repositories and recorded responses with frontier tickets, when list runs, then the frontier is printed grouped by repository and ordered oldest first, and a repository with none says so', async (t) => {
  const { env, app } = declaring({
    forge: { github: 'rameezk/forge' },
    mirror: { github: 'rameezk/forge-mirror' },
    quiet: { github: 'rameezk/quiet' },
  });
  const github = replaying({
    'rameezk/forge': recorded('frontier'),
    'rameezk/forge-mirror': reshaped('frontier', (nodes) =>
      nodes
        .slice(0, 2)
        .map((node, index) => (index === 1 ? { ...node, parent: null } : node))
        .reverse(),
    ),
    'rameezk/quiet': reshaped('frontier', () => []),
  });
  const output = printing(t);

  const code = await run(app, ['list'], env, github.fetch);

  assert.equal(code, 0);
  assert.equal(output.stderr(), '');
  assert.equal(
    output.stdout(),
    [
      'forge (rameezk/forge)',
      '  #57 Frontier sync survives real-world GitHub',
      '      https://github.com/rameezk/forge/issues/57',
      '      spec #54 Frontier discovery across managed repositories, created 2026-09-28',
      '  #58 forge-frontier list shows the frontier on demand',
      '      https://github.com/rameezk/forge/issues/58',
      '      spec #54 Frontier discovery across managed repositories, created 2026-09-28',
      '  #62 Runtime secrets decrypted on the box via sops-nix',
      '      https://github.com/rameezk/forge/issues/62',
      '      spec #61 Secrets via sops-nix, created 2026-09-28',
      '  #63 Hetzner token from sops instead of .env',
      '      https://github.com/rameezk/forge/issues/63',
      '      spec #61 Secrets via sops-nix, created 2026-09-28',
      '  #69 Ship sqlite on the box',
      '      https://github.com/rameezk/forge/issues/69',
      '      spec #67 Billed cost settles after the run, created 2026-09-28',
      '  #70 Billed cost settles after the run',
      '      https://github.com/rameezk/forge/issues/70',
      '      spec #67 Billed cost settles after the run, created 2026-09-28',
      '',
      'mirror (rameezk/forge-mirror)',
      '  #57 Frontier sync survives real-world GitHub',
      '      https://github.com/rameezk/forge/issues/57',
      '      spec #54 Frontier discovery across managed repositories, created 2026-09-28',
      '  #58 forge-frontier list shows the frontier on demand',
      '      https://github.com/rameezk/forge/issues/58',
      '      no parent spec, created 2026-09-28',
      '',
      'quiet (rameezk/quiet)',
      '  no tickets on the frontier',
    ].join('\n'),
  );
});

test('given a store holding an existing snapshot, when list runs, then the store is unchanged', async (t) => {
  const { stateDir, env, app } = declaring({
    forge: { github: 'rameezk/forge' },
    fresh: { github: 'rameezk/fresh' },
  });
  seeding(stateDir, [
    {
      repository: 'forge',
      github: 'rameezk/forge',
      polledAt: '2026-09-29T08:00:00.000Z',
      closed: [], requests: [],
      tickets: [staleTicket('rameezk/forge', 1)],
    },
    {
      repository: 'retired',
      github: 'rameezk/retired',
      polledAt: '2026-09-29T08:00:00.000Z',
      closed: [], requests: [],
      tickets: [staleTicket('rameezk/retired', 3)],
    },
  ]);
  const before = storedFrontier(stateDir);
  const github = replaying({
    'rameezk/forge': recorded('frontier'),
    'rameezk/fresh': recorded('frontier'),
  });
  printing(t);

  const code = await run(app, ['list'], env, github.fetch);

  assert.equal(code, 0);
  assert.equal(github.requests.length, 4);
  assert.deepEqual(storedFrontier(stateDir), before);
});

test('given GitHub fails for one of two declared repositories, when list runs, then the healthy frontier is printed, the failing repository shows its error and the exit code is non-zero', async (t) => {
  const { env, app } = declaring({
    gone: { github: 'rameezk/forge-does-not-exist' },
    mirror: { github: 'rameezk/forge-mirror' },
  });
  const github = replaying({
    'rameezk/forge-does-not-exist': recorded('not-found'),
    'rameezk/forge-mirror': reshaped('frontier', (nodes) => nodes.slice(0, 1)),
  });
  const output = printing(t);

  const code = await run(app, ['list'], env, github.fetch);

  assert.notEqual(code, 0);
  assert.equal(
    output.stdout(),
    [
      'gone (rameezk/forge-does-not-exist)',
      "  error: GitHub rejected the Frontier query for rameezk/forge-does-not-exist: Could not resolve to a Repository with the name 'rameezk/forge-does-not-exist'.",
      '',
      'mirror (rameezk/forge-mirror)',
      '  #57 Frontier sync survives real-world GitHub',
      '      https://github.com/rameezk/forge/issues/57',
      '      spec #54 Frontier discovery across managed repositories, created 2026-09-28',
    ].join('\n'),
  );
});

for (const [absence, message, override] of MISSING_APP) {
  test(`given ${absence}, when list runs, then every declared repository shows the missing App credential, no GitHub request is made and the exit code is non-zero`, async (t) => {
    const { stateDir, env, app } = declaring({
      forge: { github: 'rameezk/forge' },
      fresh: { github: 'rameezk/fresh' },
    });
    const github = replaying({ 'rameezk/forge': recorded('frontier') });
    const output = printing(t);

    const code = await run(app, 
      ['list'],
      { ...env, ...override(stateDir) },
      github.fetch,
    );

    assert.notEqual(code, 0);
    assert.deepEqual(github.requests, []);
    assert.equal(
      output.stdout(),
      [
        'forge (rameezk/forge)',
        `  error: ${message}`,
        '',
        'fresh (rameezk/fresh)',
        `  error: ${message}`,
      ].join('\n'),
    );
  });
}

test('given GitHub text carrying terminal control characters, when list runs, then they and bidi or format characters are stripped before printing', async (t) => {
  const { env, app } = declaring({ forge: { github: 'rameezk/forge' } });
  const github = replaying({
    'rameezk/forge': reshaped('frontier', ([node]) => [
      {
        ...node,
        title:
          '\u001b]0;pwned\u0007Frontier\u001b[2J sync\nforged line\u202e\u2066\u200b\u2028',
        url: 'https://github.com/rameezk/forge/issues/57\u001b[8m',
        parent: { number: 54, title: '\u009b31mFrontier discovery\r', url: 'https://github.com/rameezk/forge/issues/54' },
      },
    ]),
  });
  const output = printing(t);

  const code = await run(app, ['list'], env, github.fetch);

  assert.equal(code, 0);
  assert.equal(
    output.stdout(),
    [
      'forge (rameezk/forge)',
      '  #57 ]0;pwnedFrontier[2J syncforged line',
      '      https://github.com/rameezk/forge/issues/57[8m',
      '      spec #54 31mFrontier discovery, created 2026-09-28',
    ].join('\n'),
  );
});

interface LabelledPage {
  data: { repository: { issues: { nodes: { number: number }[] } } };
}

const runningIssues = (
  graphql: ReturnType<typeof replaying>,
  numbers: number[],
): ReturnType<typeof replaying> => ({
  ...graphql,
  fetch: async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Request['body'];
    if (body.variables.label !== 'forge:running') return graphql.fetch(input, init);
    const page = JSON.parse(
      readFileSync(join(FIXTURES, 'labelled-issues.json'), 'utf8'),
    ) as LabelledPage;
    page.data.repository.issues.nodes = page.data.repository.issues.nodes.filter(
      ({ number }) => numbers.includes(number),
    );
    return new Response(JSON.stringify(page), {
      headers: { 'content-type': 'application/json' },
    });
  },
});

const allForgeLabels = Object.fromEntries(
  [...FORGE_LABELS, ...STATUS_LABELS].map(({ name, color, description }) => [name, { color, description }]),
);

const dispatchedEarlier = (stateDir: string, numbers: Record<number, string>): void => {
  const store = Store.open(join(stateDir, 'forge.db'));
  try {
    for (const [number, startedAt] of Object.entries(numbers)) {
      store.startDispatch(
        { repository: 'forge', number: Number(number), url: `https://github.com/rameezk/forge/issues/${number}` },
        `run-${number}`,
        startedAt,
        10,
        null,
      );
    }
  } finally {
    store.close();
  }
};

const storedDispatches = (stateDir: string) => {
  const store = Store.open(join(stateDir, 'forge.db'));
  try {
    return store
      .listDispatches(new Date().toISOString())
      .map(({ number, state, reason }) => ({ number, state, reason }));
  } finally {
    store.close();
  }
};

test('given a repository with a worker whose forge:running tickets are one with a dispatch that stopped beating and one with a live dispatch, when sync runs, then the stale one becomes forge:failed as interrupted, losing forge:running and forge:ready, and the live one is left alone', async () => {
  const { stateDir, env, app } = declaring({ forge: { github: 'rameezk/forge', on: { ticket: 'builder' } } });
  dispatchedEarlier(stateDir, { 114: '2026-09-01T09:00:00.000Z', 123: new Date().toISOString() });
  const github = labelling(
    runningIssues(replaying({ 'rameezk/forge': recorded('frontier') }), [114, 123]),
    allForgeLabels,
  );

  const code = await run(app, 
    ['sync'],
    env,
    github.fetch,
  );

  assert.equal(code, 0);
  assert.deepEqual(
    github.calls.filter(({ path }) => path.includes('/issues/')),
    [
      { method: 'POST', path: '/repos/rameezk/forge/issues/114/labels', authorization: `bearer ${WRITE_TOKEN}`, body: { labels: ['forge:failed'] } },
      { method: 'DELETE', path: '/repos/rameezk/forge/issues/114/labels/forge%3Arunning', authorization: `bearer ${WRITE_TOKEN}`, body: null },
      { method: 'DELETE', path: '/repos/rameezk/forge/issues/114/labels/forge%3Aready', authorization: `bearer ${WRITE_TOKEN}`, body: null },
      { method: 'POST', path: '/repos/rameezk/forge/issues/114/comments', authorization: `bearer ${WRITE_TOKEN}`, body: { body: 'Forge could not finish this ticket. Details are on the forge dashboard.' } },
    ],
  );
  assert.deepEqual(storedDispatches(stateDir), [
    { number: 114, state: 'failed', reason: 'interrupted' },
    { number: 123, state: 'running', reason: null },
  ]);
});

test('given a stale forge:running ticket GitHub refuses to relabel, when sync runs, then the frontier is still stored, and the refusal is reported with a non-zero exit code', async (t) => {
  const { stateDir, env, app } = declaring({ forge: { github: 'rameezk/forge', on: { ticket: 'builder' } } });
  dispatchedEarlier(stateDir, { 114: '2026-09-01T09:00:00.000Z' });
  const labels = labelling(
    runningIssues(replaying({ 'rameezk/forge': recorded('frontier') }), [114]),
    allForgeLabels,
  );
  const refusing = async (input: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> =>
    String(input).includes('/issues/') ? new Response('{}', { status: 403 }) : labels.fetch(input, init);
  const stderr: string[] = [];
  t.mock.method(console, 'error', (line: string) => stderr.push(line));

  const code = await run(app, 
    ['sync'],
    env,
    refusing,
  );

  assert.notEqual(code, 0);
  assert.equal(storedFrontier(stateDir)[0]?.tickets.length, 7);
  assert.deepEqual(stderr, [
    'forge: could not settle tickets labelled forge:running: GitHub answered 403 labelling rameezk/forge#114 forge:failed',
  ]);
});

test('given a repository with a worker and no private key, when sync runs, then the missing key is reported for the frontier, the labels and the forge:running tickets with a non-zero exit code', async (t) => {
  const { stateDir, env, app } = declaring({ forge: { github: 'rameezk/forge', on: { ticket: 'builder' } } });
  const github = labelling(replaying({ 'rameezk/forge': recorded('frontier') }), {});
  const stderr: string[] = [];
  t.mock.method(console, 'error', (line: string) => stderr.push(line));

  const code = await run(
    app,
    ['sync'],
    { ...env, FORGE_GITHUB_APP_PRIVATE_KEY_FILE: undefined },
    github.fetch,
  );

  assert.notEqual(code, 0);
  assert.equal(storedFrontier(stateDir)[0]?.lastError?.message, 'GitHub App private key missing');
  assert.deepEqual(github.calls, []);
  assert.deepEqual(stderr, [
    'forge: GitHub App private key missing',
    'forge: no new work, its default branch rules could not be read: GitHub App private key missing; whether GitHub Actions can approve pull requests could not be read: GitHub App private key missing',
    'forge: could not ensure the forge labels: GitHub App private key missing',
    'forge: could not settle tickets labelled forge:running: GitHub App private key missing',
  ]);
});

test('given a managed repository the App is not installed on, when sync runs, then that repository shows a frontier error saying so, GitHub is not asked about it and the other repository syncs normally', async (t) => {
  const { stateDir, env, app } = declaring(
    { forge: { github: 'rameezk/forge' }, stray: { github: 'rameezk/stray' } },
    ['rameezk/stray'],
  );
  const github = replaying({ 'rameezk/forge': recorded('frontier') });
  t.mock.method(console, 'error', () => undefined);

  const code = await run(app, ['sync'], env, github.fetch);

  assert.notEqual(code, 0);
  const [forge, stray] = storedFrontier(stateDir);
  assert.equal(forge?.lastError, null);
  assert.equal(forge?.tickets.length, 7);
  assert.equal(stray?.lastError?.message, 'the GitHub App is not installed on rameezk/stray');
  assert.deepEqual(github.requests.map(({ body }) => body.variables.name), ['forge', 'forge', 'forge', 'forge', 'forge']);
});

interface RecordedPullRequest {
  data: {
    repository: {
      pullRequest: {
        state: string;
        mergedAt: string | null;
        closedAt: string | null;
        commits: { nodes: { commit: { author: { email: string } } }[] };
      };
    };
  };
}


const aPullRequest = (
  state: 'MERGED' | 'CLOSED',
  authors: string[],
): RecordedPullRequest => {
  const pullRequest = JSON.parse(
    readFileSync(join(FIXTURES, 'pull-request-merged.json'), 'utf8'),
  ) as RecordedPullRequest;
  const { pullRequest: node } = pullRequest.data.repository;
  node.state = state;
  if (state === 'CLOSED') node.mergedAt = null;
  node.commits.nodes = authors.map((email) => ({ commit: { author: { email } } }));
  return pullRequest;
};

const quiet = (graphql: ReturnType<typeof replaying>) =>
  labelling(runningIssues(graphql, []), allForgeLabels);

const pullRequestsOf = (
  graphql: Pick<ReturnType<typeof replaying>, 'fetch'>,
  responses: Record<number, RecordedPullRequest>,
) => {
  const asked: { operation: string | undefined; variables: Request['body']['variables'] }[] = [];
  const fetch = async (
    input: string | URL | globalThis.Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (init?.body === undefined) return graphql.fetch(input, init);
    const body = JSON.parse(String(init.body)) as Request['body'];
    const operation = /query (\w+)/.exec(body.query)?.[1];
    if (operation !== 'PullRequest') return graphql.fetch(input, init);
    asked.push({ operation, variables: body.variables });
    const response = responses[Number(body.variables.number)];
    if (response === undefined) {
      throw new Error(`no recorded pull request ${String(body.variables.number)}`);
    }
    return new Response(JSON.stringify(response), {
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, asked };
};

const pullRequestOf = (number: number) => ({
  number,
  url: `https://github.com/rameezk/forge/pull/${number}`,
});

const dispatchedWithPullRequest = (
  stateDir: string,
  ticket: number,
  pullRequest: number,
  settle?: (store: Store, dispatch: number) => void,
): void => {
  const store = Store.open(join(stateDir, 'forge.db'));
  try {
    const at = '2026-10-05T10:00:00.000Z';
    const start = store.startDispatch(
      { repository: 'forge', number: ticket, url: `https://github.com/rameezk/forge/issues/${ticket}` },
      `run-${ticket}`,
      at,
      10,
      null,
    );
    assert.ok('started' in start);
    store.endDispatch(start.started, { state: 'done', pullRequest: pullRequestOf(pullRequest) }, at);
    settle?.(store, start.started);
  } finally {
    store.close();
  }
};

const storedPullRequests = (stateDir: string) => {
  const store = Store.open(join(stateDir, 'forge.db'));
  try {
    return store
      .listDispatches(new Date().toISOString())
      .map(({ number, pullRequest }) => ({ number, pullRequest }));
  } finally {
    store.close();
  }
};

test('given a dispatch with an open pull request that GitHub reports merged with two commits by forge\'s identity and one by another author, when sync runs, then the pull request is merged with its merge time as settled time and a rework count of 1', async () => {
  const { stateDir, env, app } = declaring({ forge: { github: 'rameezk/forge', on: { ticket: 'builder' } } });
  dispatchedWithPullRequest(stateDir, 113, 143);
  const github = pullRequestsOf(quiet(replaying({ 'rameezk/forge': recorded('frontier') })), {
    143: aPullRequest('MERGED', [BOT_EMAIL, BOT_EMAIL.toUpperCase(), 'human@example.com']),
  });

  const code = await run(app, ['sync'], env, github.fetch);

  assert.equal(code, 0);
  assert.deepEqual(storedPullRequests(stateDir), [
    {
      number: 113,
      pullRequest: {
        ...pullRequestOf(143),
        state: 'merged',
        settledAt: '2026-10-05T12:19:41Z',
        rework: 1,
      },
    },
  ]);
  assert.deepEqual(github.asked, [
    { operation: 'PullRequest', variables: { owner: 'rameezk', name: 'forge', number: 143, after: null } },
  ]);
});

test('given a dispatch with an open pull request that GitHub reports closed without merging, when sync runs, then the pull request is closed and settled at its close time', async () => {
  const { stateDir, env, app } = declaring({ forge: { github: 'rameezk/forge', on: { ticket: 'builder' } } });
  dispatchedWithPullRequest(stateDir, 113, 143);
  const github = pullRequestsOf(quiet(replaying({ 'rameezk/forge': recorded('frontier') })), {
    143: aPullRequest('CLOSED', [BOT_EMAIL]),
  });

  await run(app, ['sync'], env, github.fetch);

  assert.deepEqual(storedPullRequests(stateDir)[0]?.pullRequest, {
    ...pullRequestOf(143),
    state: 'closed',
    settledAt: '2026-10-05T12:19:41Z',
    rework: 0,
  });
});

test('given a dispatch whose pull request is already merged, when sync runs, then GitHub is not asked about that pull request', async () => {
  const { stateDir, env, app } = declaring({ forge: { github: 'rameezk/forge', on: { ticket: 'builder' } } });
  dispatchedWithPullRequest(stateDir, 113, 143);
  const first = pullRequestsOf(quiet(replaying({ 'rameezk/forge': recorded('frontier') })), {
    143: aPullRequest('MERGED', [BOT_EMAIL]),
  });
  await run(app, ['sync'], env, first.fetch);
  const second = pullRequestsOf(quiet(replaying({ 'rameezk/forge': recorded('frontier') })), {});

  const code = await run(app, ['sync'], env, second.fetch);

  assert.equal(code, 0);
  assert.deepEqual(second.asked, []);
  assert.equal(storedPullRequests(stateDir)[0]?.pullRequest?.state, 'merged');
});

test('given a pull request whose commits span two pages, when sync runs, then its rework counts the commits of both pages', async () => {
  const { stateDir, env, app } = declaring({ forge: { github: 'rameezk/forge', on: { ticket: 'builder' } } });
  dispatchedWithPullRequest(stateDir, 113, 143);
  const graphql = quiet(replaying({ 'rameezk/forge': recorded('frontier') }));
  const firstPage = aPullRequest('MERGED', [BOT_EMAIL, 'human@example.com']);
  const secondPage = aPullRequest('MERGED', ['human@example.com', BOT_EMAIL]);
  const pages = [firstPage, secondPage].map((page, index, all) => ({
    ...page,
    data: {
      repository: {
        pullRequest: {
          ...page.data.repository.pullRequest,
          commits: {
            ...page.data.repository.pullRequest.commits,
            pageInfo: { hasNextPage: index < all.length - 1, endCursor: `cursor-${index}` },
          },
        },
      },
    },
  }));
  const paged = async (input: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> => {
    if (init?.body === undefined) return graphql.fetch(input, init);
    const body = JSON.parse(String(init.body)) as Request['body'];
    if (!body.query.includes('query PullRequest')) return graphql.fetch(input, init);
    const page = pages[body.variables.after === null ? 0 : 1];
    return new Response(JSON.stringify(page), { headers: { 'content-type': 'application/json' } });
  };

  await run(app, ['sync'], env, paged);

  assert.equal(storedPullRequests(stateDir)[0]?.pullRequest?.rework, 2);
});

test('given three dispatches whose pull requests GitHub fails for, reports in an unknown state, and reports merged, when sync runs, then only the merged one settles, and the other two stay open with each failure reported and a non-zero exit code', async (t) => {
  const { stateDir, env, app } = declaring({ forge: { github: 'rameezk/forge', on: { ticket: 'builder' } } });
  dispatchedWithPullRequest(stateDir, 113, 143);
  dispatchedWithPullRequest(stateDir, 114, 144);
  dispatchedWithPullRequest(stateDir, 115, 145);
  const graphql = quiet(replaying({ 'rameezk/forge': recorded('frontier') }));
  const answering = async (input: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> => {
    if (init?.body === undefined) return graphql.fetch(input, init);
    const body = JSON.parse(String(init.body)) as Request['body'];
    if (!body.query.includes('query PullRequest')) return graphql.fetch(input, init);
    if (body.variables.number === 143) return new Response('{}', { status: 502 });
    const pullRequest = aPullRequest('MERGED', [BOT_EMAIL]);
    if (body.variables.number === 144) pullRequest.data.repository.pullRequest.state = 'DRAFT';
    return new Response(JSON.stringify(pullRequest), { headers: { 'content-type': 'application/json' } });
  };
  const stderr: string[] = [];
  t.mock.method(console, 'error', (line: string) => stderr.push(line));

  const code = await run(app, ['sync'], env, answering);

  assert.notEqual(code, 0);
  assert.deepEqual(
    storedPullRequests(stateDir).map(({ number, pullRequest }) => ({ number, state: pullRequest?.state })),
    [
      { number: 113, state: 'open' },
      { number: 114, state: 'open' },
      { number: 115, state: 'merged' },
    ],
  );
  assert.deepEqual(stderr, [
    'forge: could not refresh pull request #143: GitHub answered 502 for rameezk/forge#143',
    "forge: could not refresh pull request #144: GitHub reported rameezk/forge#144 in an unknown state 'DRAFT'",
  ]);
});

test('given a dispatch with an open pull request in a repository that no longer declares a worker, when sync runs, then its pull request is still refreshed', async () => {
  const { stateDir, env, app } = declaring({ forge: { github: 'rameezk/forge' } });
  dispatchedWithPullRequest(stateDir, 113, 143);
  const github = pullRequestsOf(quiet(replaying({ 'rameezk/forge': recorded('frontier') })), {
    143: aPullRequest('MERGED', [BOT_EMAIL]),
  });

  await run(app, ['sync'], env, github.fetch);

  assert.equal(storedPullRequests(stateDir)[0]?.pullRequest?.state, 'merged');
});

type Event = [label: string, login: string, at: string];

interface AutoApproval {
  timelines: Record<number, Event[]>;
  maintainers: string[];
  bodyEdits?: Record<number, [login: string, at: string][]>;
  renames?: Record<number, [login: string, at: string][]>;
}

const actorOf = (login: string) => ({ __typename: 'User', login });

const approving = (
  inner: typeof globalThis.fetch,
  { timelines, maintainers, bodyEdits = {}, renames = {} }: AutoApproval,
): typeof globalThis.fetch =>
  async (input, init) => {
    const url = new URL(String(input));
    const permission = /\/collaborators\/([^/]+)\/permission$/.exec(url.pathname);
    if (permission !== null) {
      const login = decodeURIComponent(permission[1] ?? '');
      return maintainers.includes(login)
        ? Response.json({ permission: 'write' })
        : new Response('{}', { status: 404 });
    }
    if (url.pathname !== '/graphql') return inner(input, init);
    const { query, variables } = JSON.parse(String(init?.body)) as Request['body'];
    const number = Number(variables.number);
    const pageInfo = { hasPreviousPage: false, hasNextPage: false, startCursor: null, endCursor: null };
    const issue = (fields: Record<string, unknown>) =>
      Response.json({ data: { repository: { issue: fields } } });
    if (query.includes('query TicketApproval')) {
      return issue({
        timelineItems: {
          pageInfo,
          nodes: (timelines[number] ?? []).map(([label, login, at]) => ({
            __typename: 'LabeledEvent',
            createdAt: at,
            label: { name: label },
            actor: actorOf(login),
          })),
        },
      });
    }
    if (query.includes('query TicketRenames')) {
      return issue({
        timelineItems: {
          pageInfo,
          nodes: (renames[number] ?? []).map(([login, at]) => ({
            __typename: 'RenamedTitleEvent',
            createdAt: at,
            actor: actorOf(login),
          })),
        },
      });
    }
    if (query.includes('query TicketBodyEdits')) {
      return issue({
        userContentEdits: {
          pageInfo,
          nodes: (bodyEdits[number] ?? []).map(([login, at]) => ({ editedAt: at, editor: actorOf(login) })),
        },
      });
    }
    return inner(input, init);
  };

const autoApproved = async (
  scenario: AutoApproval,
  options: { autoApprove?: boolean; response?: string; edit?: (pages: RecordedPage[]) => void } = {},
) => {
  const { autoApprove = true, response = 'frontier', edit } = options;
  const { stateDir, env, app } = declaring({
    forge: { github: 'rameezk/forge', on: { ticket: 'builder' }, ...(autoApprove ? { autoApprove: true } : {}) },
  });
  const pages = recorded(response);
  edit?.(pages);
  const github = labelling(
    runningIssues(replaying({ 'rameezk/forge': pages }), []),
    allForgeLabels,
  );
  const code = await run(app, ['sync'], env, approving(github.fetch, scenario));
  return {
    code,
    stateDir,
    writes: github.calls.filter(({ path }) => path.includes('/issues/')),
    labelled: github.calls
      .filter(({ method, path }) => method === 'POST' && path.endsWith('/labels') && path.includes('/issues/'))
      .map(({ path, body }) => `${path.split('/').at(-2)}:${JSON.stringify(body)}`),
  };
};

const forgeReadyOn = (number: number) => `${number}:{"labels":["forge:ready"]}`;

const storedTicket = (stateDir: string, number: number) =>
  storedFrontier(stateDir)[0]?.tickets.find((ticket) => ticket.number === number);

const RFA_AT = '2026-10-01T10:00:00Z';
const LATER = '2026-10-01T11:00:00Z';
const LATEST = '2026-10-01T12:00:00Z';

test('given an auto-approving repository and a ticket a maintainer labelled ready-for-agent with no forge label, when sync runs, then forge labels it forge:ready with the write token and stores it as queued', async () => {
  const { code, stateDir, writes, labelled } = await autoApproved({
    timelines: { 57: [['ready-for-agent', 'teammate', RFA_AT]] },
    maintainers: ['teammate'],
  });

  assert.equal(code, 0);
  assert.deepEqual(labelled, [forgeReadyOn(57)]);
  assert.equal(writes[0]?.authorization, `bearer ${WRITE_TOKEN}`);
  assert.equal(storedTicket(stateDir, 57)?.forgeReady, true);
  assert.equal(storedTicket(stateDir, 58)?.forgeReady, false);
});

test('given an auto-approving repository and a blocked ticket a maintainer labelled ready-for-agent, when sync runs, then it carries forge:ready and is stored as queued', async () => {
  const { stateDir, labelled } = await autoApproved(
    { timelines: { 201: [['ready-for-agent', 'teammate', RFA_AT]] }, maintainers: ['teammate'] },
    { response: 'blocked-agent' },
  );

  assert.deepEqual(labelled, [forgeReadyOn(201)]);
  const ticket = storedTicket(stateDir, 201);
  assert.equal(ticket?.forgeReady, true);
  assert.equal(ticket?.blocked, true);
});

test('given a repository that has not opted in and a ticket a maintainer labelled ready-for-agent, when sync runs, then the ticket gains no forge:ready', async () => {
  const { writes, stateDir } = await autoApproved(
    { timelines: { 57: [['ready-for-agent', 'teammate', RFA_AT]] }, maintainers: ['teammate'] },
    { autoApprove: false },
  );

  assert.deepEqual(writes, []);
  assert.equal(storedTicket(stateDir, 57)?.forgeReady, false);
});

test('given an auto-approving repository and a ticket whose latest ready-for-agent someone without write access applied, when sync runs, then it gains no forge:ready, no forge:failed and no comment', async () => {
  for (const timeline of [
    [['ready-for-agent', 'outsider', RFA_AT]],
    [['ready-for-agent', 'teammate', RFA_AT], ['ready-for-agent', 'outsider', LATER]],
  ] as Event[][]) {
    const { writes, code } = await autoApproved({ timelines: { 57: timeline }, maintainers: ['teammate'] });

    assert.equal(code, 0);
    assert.deepEqual(writes, []);
  }
});

test('given an auto-approving repository and a ticket a maintainer labelled ready-for-agent whose body or title, or whose parent spec\'s body or title, an outsider edited afterwards, when sync runs, then it gains no forge:ready', async () => {
  const outsider: [string, string][] = [['outsider', LATER]];
  const cases: Partial<AutoApproval>[] = [
    { bodyEdits: { 57: outsider } },
    { renames: { 57: outsider } },
    { bodyEdits: { 54: outsider } },
    { renames: { 54: outsider } },
  ];
  for (const edits of cases) {
    const { writes } = await autoApproved({
      timelines: { 57: [['ready-for-agent', 'teammate', RFA_AT]] },
      maintainers: ['teammate'],
      ...edits,
    });

    assert.deepEqual(writes, [], JSON.stringify(edits));
  }
});

test('given an auto-approving repository and a ticket whose outsider edit predates the maintainer\'s ready-for-agent or whose edits a maintainer made, when sync runs, then it carries forge:ready', async () => {
  const { labelled } = await autoApproved({
    timelines: { 57: [['ready-for-agent', 'teammate', LATER]], 58: [['ready-for-agent', 'teammate', RFA_AT]] },
    maintainers: ['teammate'],
    bodyEdits: { 57: [['outsider', RFA_AT]], 58: [['teammate', LATER]] },
  });

  assert.deepEqual(labelled, [forgeReadyOn(57), forgeReadyOn(58)]);
});

test('given a ticket forge labelled forge:ready from which a maintainer then removed it, when sync runs again, then it gains no forge:ready, and once a maintainer applies ready-for-agent again, it does', async () => {
  const held: Event[] = [
    ['ready-for-agent', 'teammate', RFA_AT],
    ['forge:ready', 'forge[bot]', LATER],
  ];
  const first = await autoApproved({ timelines: { 57: held }, maintainers: ['teammate'] });
  const second = await autoApproved({
    timelines: { 57: [...held, ['ready-for-agent', 'teammate', LATEST]] },
    maintainers: ['teammate'],
  });

  assert.deepEqual(first.writes, []);
  assert.deepEqual(second.labelled, [forgeReadyOn(57)]);
});

test('given a ticket a maintainer labelled ready-for-agent and forge:ready within the same second, when sync runs, then it gains no forge:ready', async () => {
  const { writes } = await autoApproved({
    timelines: { 57: [['ready-for-agent', 'teammate', RFA_AT], ['forge:ready', 'forge[bot]', RFA_AT]] },
    maintainers: ['teammate'],
  });

  assert.deepEqual(writes, []);
});

test('given a ticket carrying forge:failed, running or done, when sync runs, then it gains no forge:ready', async () => {
  for (const label of ['forge:failed', 'forge:running', 'forge:done']) {
    const { writes } = await autoApproved(
      { timelines: { 57: [['ready-for-agent', 'teammate', RFA_AT]] }, maintainers: ['teammate'] },
      {
        edit: (pages) => {
          for (const page of pages) {
            const node = page.data?.repository?.issues.nodes.find(({ number }) => number === 57);
            (node?.labels as { nodes: { name: string }[] } | undefined)?.nodes.push({ name: label });
          }
        },
      },
    );

    assert.deepEqual(writes, [], label);
  }
});

test('given an auto-approving repository with several ready-for-agent tickets, some approved by maintainers and one by an outsider, when sync runs, then every maintainer-approved ticket without a forge label carries forge:ready and the outsider\'s does not', async () => {
  const { labelled, code } = await autoApproved({
    timelines: {
      57: [['ready-for-agent', 'teammate', RFA_AT]],
      58: [['ready-for-agent', 'outsider', RFA_AT]],
      62: [['ready-for-agent', 'owner', RFA_AT]],
      63: [['ready-for-agent', 'teammate', RFA_AT]],
      69: [['ready-for-agent', 'teammate', RFA_AT]],
    },
    maintainers: ['teammate', 'owner'],
  });

  assert.equal(code, 0);
  assert.deepEqual(labelled, [forgeReadyOn(57), forgeReadyOn(62), forgeReadyOn(63)]);
});

test('given an auto-approving repository where GitHub fails reading one ticket\'s timeline, when sync runs, then the other tickets are labelled, the frontier is stored and the failure is reported with a non-zero exit code', async (t) => {
  const stderr: string[] = [];
  t.mock.method(console, 'error', (line: string) => stderr.push(line));
  const scenario: AutoApproval = {
    timelines: { 57: [['ready-for-agent', 'teammate', RFA_AT]], 58: [['ready-for-agent', 'teammate', RFA_AT]] },
    maintainers: ['teammate'],
  };
  const { stateDir, env, app } = declaring({
    forge: { github: 'rameezk/forge', on: { ticket: 'builder' }, autoApprove: true },
  });
  const github = labelling(runningIssues(replaying({ 'rameezk/forge': recorded('frontier') }), []), allForgeLabels);
  const answering = approving(github.fetch, scenario);
  const failing: typeof globalThis.fetch = async (input, init) =>
    String(init?.body).includes('"number":57') && String(init?.body).includes('TicketApproval')
      ? new Response('{}', { status: 502 })
      : answering(input, init);

  const code = await run(app, ['sync'], env, failing);

  assert.notEqual(code, 0);
  assert.equal(storedFrontier(stateDir)[0]?.tickets.length, 7);
  assert.deepEqual(
    github.calls.filter(({ method, path }) => method === 'POST' && path.endsWith('/issues/58/labels')).length,
    1,
  );
  assert.deepEqual(stderr, ['rameezk/forge#57: could not auto-approve: GitHub answered 502 for rameezk/forge#57']);
});
