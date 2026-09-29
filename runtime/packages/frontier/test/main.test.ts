import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GITHUB_GRAPHQL_API, Store } from '@forge/shared';
import type { PolledFrontier, Ticket } from '@forge/shared';
import { main } from '../src/main.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'github');

interface RecordedPage {
  data?: {
    repository: {
      issues: {
        pageInfo: { endCursor: string | null };
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

const GITHUB_TOKEN = 'github_pat_test';

interface Request {
  url: string;
  method: string | undefined;
  authorization: string | null;
  body: { query: string; variables: Record<string, string | number | null> };
}

const replaying = (responses: Record<string, RecordedPage[]>) => {
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
    const pages = responses[github];
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

const declaring = (repositories: Record<string, { github: string }>) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'forge-frontier-'));
  const configPath = join(stateDir, 'runtime.json');
  writeFileSync(
    configPath,
    JSON.stringify({ harnesses: {}, workers: {}, repositories }),
  );
  return {
    stateDir,
    env: {
      FORGE_RUNTIME_CONFIG: configPath,
      FORGE_STATE_DIR: stateDir,
      GITHUB_TOKEN,
    },
  };
};

const storedFrontier = (stateDir: string) => {
  const store = Store.open(join(stateDir, 'forge.db'));
  try {
    return store.listFrontier();
  } finally {
    store.close();
  }
};

test('given a declared repository whose recorded response holds unblocked and blocked ready-for-agent issues, when sync runs, then the store holds only the unblocked tickets and when the repository was polled', async () => {
  const { stateDir, env } = declaring({ forge: { github: 'rameezk/forge' } });
  const github = replaying({ 'rameezk/forge': recorded('frontier') });

  const before = new Date().toISOString();
  const code = await main(['sync'], env, github.fetch);
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
    forge.tickets.map((ticket) => ticket.number),
    [57, 58, 62, 63, 69, 70],
    'blocked ticket 64 stays off the frontier',
  );
  assert.deepEqual(forge.tickets[0], {
    number: 57,
    title: 'Frontier sync survives real-world GitHub',
    url: 'https://github.com/rameezk/forge/issues/57',
    parent: {
      number: 54,
      title: 'Frontier discovery across managed repositories',
    },
    createdAt: '2026-09-28T10:08:01Z',
  });
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
        variables: { owner: 'rameezk', name: 'forge', first: 100, after: null },
      },
    ],
  );
});

test('given a declared repository whose recorded response spans several pages, when sync runs, then tickets from every page are stored', async () => {
  const { stateDir, env } = declaring({ forge: { github: 'rameezk/forge' } });
  const pages = recorded('frontier-paged');
  const github = replaying({ 'rameezk/forge': pages });

  const code = await main(['sync'], env, github.fetch);

  assert.equal(code, 0);
  const [forge] = storedFrontier(stateDir);
  assert.deepEqual(
    forge?.tickets.map((ticket) => ticket.number),
    [57, 58, 62, 63, 69, 70],
  );
  assert.deepEqual(
    github.requests.map(({ body }) => body.variables.after),
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
});

test('given two declared repositories with stored snapshots where GitHub now fails for one, when sync runs, then the healthy snapshot is replaced and the failing one keeps its previous tickets and polled time with the error as its last error', async () => {
  const { stateDir, env } = declaring({
    forge: { github: 'rameezk/forge' },
    gone: { github: 'rameezk/forge-does-not-exist' },
  });
  const previousPoll = '2026-09-29T08:00:00.000Z';
  seeding(stateDir, [
    {
      repository: 'forge',
      github: 'rameezk/forge',
      polledAt: previousPoll,
      tickets: [staleTicket('rameezk/forge', 1)],
    },
    {
      repository: 'gone',
      github: 'rameezk/forge-does-not-exist',
      polledAt: previousPoll,
      tickets: [staleTicket('rameezk/forge-does-not-exist', 2)],
    },
  ]);
  const github = replaying({
    'rameezk/forge': recorded('frontier'),
    'rameezk/forge-does-not-exist': recorded('not-found'),
  });

  const before = new Date().toISOString();
  const code = await main(['sync'], env, github.fetch);
  const after = new Date().toISOString();

  assert.notEqual(code, 0);
  const [forge, gone] = storedFrontier(stateDir);
  assert.deepEqual(
    forge?.tickets.map((ticket) => ticket.number),
    [57, 58, 62, 63, 69, 70],
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
        "GitHub rejected the frontier query for rameezk/forge-does-not-exist: Could not resolve to a Repository with the name 'rameezk/forge-does-not-exist'.",
      failedAt,
    },
    tickets: [staleTicket('rameezk/forge-does-not-exist', 2)],
  });
});

for (const [absence, token] of [
  ['no', undefined],
  ['an empty', ''],
] as const) {
  test(`given ${absence} GITHUB_TOKEN, when sync runs, then every declared repository records a token-missing error, no GitHub request is made and the exit code is non-zero`, async () => {
    const { stateDir, env } = declaring({
      forge: { github: 'rameezk/forge' },
      fresh: { github: 'rameezk/fresh' },
    });
    const previousPoll = '2026-09-29T08:00:00.000Z';
    seeding(stateDir, [
      {
        repository: 'forge',
        github: 'rameezk/forge',
        polledAt: previousPoll,
        tickets: [staleTicket('rameezk/forge', 1)],
      },
    ]);
    const github = replaying({ 'rameezk/forge': recorded('frontier') });

    const code = await main(
      ['sync'],
      { ...env, GITHUB_TOKEN: token },
      github.fetch,
    );

    assert.notEqual(code, 0);
    assert.deepEqual(github.requests, []);
    const stored = storedFrontier(stateDir);
    assert.deepEqual(
      stored.map(({ lastError }) => lastError?.message),
      ['GitHub token missing', 'GitHub token missing'],
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
  const { stateDir, env } = declaring({ forge: { github: 'rameezk/forge' } });
  seeding(stateDir, [
    {
      repository: 'retired',
      github: 'rameezk/retired',
      polledAt: '2026-09-29T08:00:00.000Z',
      tickets: [staleTicket('rameezk/retired', 3)],
    },
  ]);
  const github = replaying({ 'rameezk/forge': recorded('frontier') });

  const code = await main(['sync'], env, github.fetch);

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
  const { stateDir, env } = declaring({ forge: { github: 'rameezk/forge' } });
  const [first] = recorded('frontier-paged');
  assert.ok(first);
  const github = replaying({ 'rameezk/forge': [first, first] });

  const code = await main(['sync'], env, github.fetch);

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
  const { env } = declaring({
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

  const code = await main(['list'], env, github.fetch);

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
  const { stateDir, env } = declaring({
    forge: { github: 'rameezk/forge' },
    fresh: { github: 'rameezk/fresh' },
  });
  seeding(stateDir, [
    {
      repository: 'forge',
      github: 'rameezk/forge',
      polledAt: '2026-09-29T08:00:00.000Z',
      tickets: [staleTicket('rameezk/forge', 1)],
    },
    {
      repository: 'retired',
      github: 'rameezk/retired',
      polledAt: '2026-09-29T08:00:00.000Z',
      tickets: [staleTicket('rameezk/retired', 3)],
    },
  ]);
  const before = storedFrontier(stateDir);
  const github = replaying({
    'rameezk/forge': recorded('frontier'),
    'rameezk/fresh': recorded('frontier'),
  });
  printing(t);

  const code = await main(['list'], env, github.fetch);

  assert.equal(code, 0);
  assert.equal(github.requests.length, 2);
  assert.deepEqual(storedFrontier(stateDir), before);
});

test('given GitHub fails for one of two declared repositories, when list runs, then the healthy frontier is printed, the failing repository shows its error and the exit code is non-zero', async (t) => {
  const { env } = declaring({
    gone: { github: 'rameezk/forge-does-not-exist' },
    mirror: { github: 'rameezk/forge-mirror' },
  });
  const github = replaying({
    'rameezk/forge-does-not-exist': recorded('not-found'),
    'rameezk/forge-mirror': reshaped('frontier', (nodes) => nodes.slice(0, 1)),
  });
  const output = printing(t);

  const code = await main(['list'], env, github.fetch);

  assert.notEqual(code, 0);
  assert.equal(
    output.stdout(),
    [
      'gone (rameezk/forge-does-not-exist)',
      "  error: GitHub rejected the frontier query for rameezk/forge-does-not-exist: Could not resolve to a Repository with the name 'rameezk/forge-does-not-exist'.",
      '',
      'mirror (rameezk/forge-mirror)',
      '  #57 Frontier sync survives real-world GitHub',
      '      https://github.com/rameezk/forge/issues/57',
      '      spec #54 Frontier discovery across managed repositories, created 2026-09-28',
    ].join('\n'),
  );
});

for (const [absence, token] of [
  ['no', undefined],
  ['an empty', ''],
] as const) {
  test(`given ${absence} GITHUB_TOKEN, when list runs, then every declared repository shows the token-missing error, no GitHub request is made and the exit code is non-zero`, async (t) => {
    const { env } = declaring({
      forge: { github: 'rameezk/forge' },
      fresh: { github: 'rameezk/fresh' },
    });
    const github = replaying({ 'rameezk/forge': recorded('frontier') });
    const output = printing(t);

    const code = await main(
      ['list'],
      { ...env, GITHUB_TOKEN: token },
      github.fetch,
    );

    assert.notEqual(code, 0);
    assert.deepEqual(github.requests, []);
    assert.equal(
      output.stdout(),
      [
        'forge (rameezk/forge)',
        '  error: GitHub token missing',
        '',
        'fresh (rameezk/fresh)',
        '  error: GitHub token missing',
      ].join('\n'),
    );
  });
}

test('given GitHub text carrying terminal control characters, when list runs, then they are stripped before printing', async (t) => {
  const { env } = declaring({ forge: { github: 'rameezk/forge' } });
  const github = replaying({
    'rameezk/forge': reshaped('frontier', ([node]) => [
      {
        ...node,
        title: '\u001b]0;pwned\u0007Frontier\u001b[2J sync\nforged line',
        url: 'https://github.com/rameezk/forge/issues/57\u001b[8m',
        parent: { number: 54, title: '\u009b31mFrontier discovery\r' },
      },
    ]),
  });
  const output = printing(t);

  const code = await main(['list'], env, github.fetch);

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
