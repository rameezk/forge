import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GITHUB_GRAPHQL_API, Store } from '@forge/shared';
import type { PolledFrontier, Ticket } from '@forge/shared';
import { main } from '../src/main.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'github');

const recorded = (name: string): string[] =>
  (JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as unknown[]).map(
    (page) => JSON.stringify(page),
  );

const endCursor = (page: string): string =>
  (JSON.parse(page) as { data: { repository: { issues: { pageInfo: { endCursor: string } } } } })
    .data.repository.issues.pageInfo.endCursor;

const GITHUB_TOKEN = 'github_pat_test';

interface Request {
  url: string;
  method: string | undefined;
  authorization: string | null;
  body: { query: string; variables: Record<string, string | number | null> };
}

const replaying = (responses: Record<string, string[]>) => {
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
      index === 0 ? after === null : endCursor(pages[index - 1] ?? '') === after,
    );
    return response === undefined
      ? new Response('{"message":"Not Found"}', { status: 404 })
      : new Response(response, {
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
  assert.ok(forge.polledAt !== null && before <= forge.polledAt && forge.polledAt <= after);
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
  const github = replaying({ 'rameezk/forge': recorded('frontier-paged') });

  const code = await main(['sync'], env, github.fetch);

  assert.equal(code, 0);
  const [forge] = storedFrontier(stateDir);
  assert.deepEqual(
    forge?.tickets.map((ticket) => ticket.number),
    [57, 58, 62, 63, 69, 70],
  );
  assert.deepEqual(
    github.requests.map(({ body }) => body.variables.after),
    [null, ...recorded('frontier-paged').slice(0, 2).map(endCursor)],
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
    gone: { github: 'rameezk/gone' },
  });
  const previousPoll = '2026-09-29T08:00:00.000Z';
  seeding(stateDir, [
    { repository: 'forge', github: 'rameezk/forge', polledAt: previousPoll, tickets: [staleTicket('rameezk/forge', 1)] },
    { repository: 'gone', github: 'rameezk/gone', polledAt: previousPoll, tickets: [staleTicket('rameezk/gone', 2)] },
  ]);
  const github = replaying({ 'rameezk/forge': recorded('frontier') });

  const code = await main(['sync'], env, github.fetch);

  assert.notEqual(code, 0);
  const [forge, gone] = storedFrontier(stateDir);
  assert.deepEqual(
    forge?.tickets.map((ticket) => ticket.number),
    [57, 58, 62, 63, 69, 70],
  );
  assert.ok(forge && forge.polledAt !== previousPoll);
  assert.equal(forge.lastError, null);
  assert.deepEqual(gone, {
    repository: 'gone',
    github: 'rameezk/gone',
    polledAt: previousPoll,
    lastError: 'GitHub answered 404 for rameezk/gone',
    tickets: [staleTicket('rameezk/gone', 2)],
  });
});

for (const [absence, token] of [['no', undefined], ['an empty', '']] as const) {
  test(`given ${absence} GITHUB_TOKEN, when sync runs, then every declared repository records a token-missing error, no GitHub request is made and the exit code is non-zero`, async () => {
    const { stateDir, env } = declaring({
      forge: { github: 'rameezk/forge' },
      fresh: { github: 'rameezk/fresh' },
    });
    const previousPoll = '2026-09-29T08:00:00.000Z';
    seeding(stateDir, [
      { repository: 'forge', github: 'rameezk/forge', polledAt: previousPoll, tickets: [staleTicket('rameezk/forge', 1)] },
    ]);
    const github = replaying({ 'rameezk/forge': recorded('frontier') });

    const code = await main(['sync'], { ...env, GITHUB_TOKEN: token }, github.fetch);

    assert.notEqual(code, 0);
    assert.deepEqual(github.requests, []);
    assert.deepEqual(storedFrontier(stateDir), [
      {
        repository: 'forge',
        github: 'rameezk/forge',
        polledAt: previousPoll,
        lastError: 'GitHub token missing',
        tickets: [staleTicket('rameezk/forge', 1)],
      },
      {
        repository: 'fresh',
        github: 'rameezk/fresh',
        polledAt: null,
        lastError: 'GitHub token missing',
        tickets: [],
      },
    ]);
  });
}

test('given stored rows for a repository no longer declared, when sync runs, then those rows are gone', async () => {
  const { stateDir, env } = declaring({ forge: { github: 'rameezk/forge' } });
  seeding(stateDir, [
    { repository: 'retired', github: 'rameezk/retired', polledAt: '2026-09-29T08:00:00.000Z', tickets: [staleTicket('rameezk/retired', 3)] },
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
      db.prepare("SELECT number FROM frontier_tickets WHERE repository = 'retired'").all(),
      [],
    );
  } finally {
    db.close();
  }
});
