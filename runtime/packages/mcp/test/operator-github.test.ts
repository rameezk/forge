import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OperatorGitHub } from '../src/index.ts';

interface Request {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

const recording = (respond: (request: Request) => unknown) => {
  const requests: Request[] = [];
  const fetch = (async (input: string, init: RequestInit = {}) => {
    const request: Request = {
      method: init.method ?? 'GET',
      url: input,
      authorization: new Headers(init.headers).get('authorization'),
      body: init.body === undefined ? undefined : JSON.parse(init.body as string),
    };
    requests.push(request);
    return new Response(JSON.stringify(respond(request)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { requests, github: new OperatorGitHub(async () => 'operator-token', fetch) };
};

test('given the operator signed in with gh, when the adapter writes, then each write is one REST call carrying the operator token', async () => {
  const { requests, github } = recording(() => ({}));

  await github.applyForgeReady('rameezk/forge', 7);
  await github.assign('rameezk/forge', 7, 'operator');
  await github.unassign('rameezk/forge', 7, 'operator');

  assert.deepEqual(
    requests.map(({ method, url, body }) => [method, url, body]),
    [
      ['POST', 'https://api.github.com/repos/rameezk/forge/issues/7/labels', { labels: ['forge:ready'] }],
      ['POST', 'https://api.github.com/repos/rameezk/forge/issues/7/assignees', { assignees: ['operator'] }],
      ['DELETE', 'https://api.github.com/repos/rameezk/forge/issues/7/assignees', { assignees: ['operator'] }],
    ],
  );
  for (const request of requests) assert.equal(request.authorization, 'bearer operator-token');
});

test('given a recorded issue response, when the adapter reads the ticket, then it returns its labels, assignees and open blockers', async () => {
  const { github } = recording(() => ({
    data: {
      repository: {
        issue: {
          url: 'https://github.com/rameezk/forge/issues/7',
          state: 'OPEN',
          labels: { nodes: [{ name: 'ready-for-agent' }] },
          assignees: { nodes: [{ login: 'alice' }] },
          blockedBy: { nodes: [{ number: 3, state: 'OPEN' }, { number: 4, state: 'CLOSED' }] },
        },
      },
    },
  }));

  assert.deepEqual(await github.issue('rameezk/forge', 7), {
    url: 'https://github.com/rameezk/forge/issues/7',
    open: true,
    labels: ['ready-for-agent'],
    assignees: ['alice'],
    blockedBy: [3],
  });
});

test('given GitHub answering the signed-in user, when the adapter asks who the operator is, then it returns the login', async () => {
  const { requests, github } = recording(() => ({ login: 'operator' }));

  assert.equal(await github.operator(), 'operator');
  assert.equal(requests[0]?.url, 'https://api.github.com/user');
});

test('given GitHub refusing an assignment, when the adapter assigns, then it fails naming the status', async () => {
  const fetch = (async () => new Response('{}', { status: 403 })) as typeof globalThis.fetch;

  await assert.rejects(new OperatorGitHub(async () => 't', fetch).assign('rameezk/forge', 7, 'operator'), /403/);
});
