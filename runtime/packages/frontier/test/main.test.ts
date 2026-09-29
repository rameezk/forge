import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GITHUB_GRAPHQL_API, Store } from '@forge/shared';
import { main } from '../src/main.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'github');

const recorded = (name: string): string =>
  readFileSync(join(FIXTURES, `${name}.json`), 'utf8');

const GITHUB_TOKEN = 'github_pat_test';

interface Request {
  url: string;
  method: string | undefined;
  authorization: string | null;
  body: { query: string; variables: Record<string, string> };
}

const replaying = (responses: Record<string, string>) => {
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
    const response = responses[github];
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
  assert.ok(before <= forge.polledAt && forge.polledAt <= after);
  assert.deepEqual(
    forge.tickets.map((ticket) => ticket.number),
    [56, 62, 63, 69, 70, 81],
    'blocked tickets 57, 58 and 64 stay off the frontier',
  );
  assert.deepEqual(forge.tickets[0], {
    number: 56,
    title: 'Declared repositories show their frontier on the dashboard',
    url: 'https://github.com/rameezk/forge/issues/56',
    parent: {
      number: 54,
      title: 'Frontier discovery across managed repositories',
    },
    createdAt: '2026-09-28T10:07:58Z',
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
        variables: { owner: 'rameezk', name: 'forge' },
      },
    ],
  );
});
