import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maintainerLookup } from '../src/maintainers.ts';

const answering =
  (status: number, permission?: string) =>
  (requests: string[]): typeof globalThis.fetch =>
  async (input) => {
    requests.push(new URL(String(input)).pathname);
    return new Response(JSON.stringify(permission === undefined ? {} : { permission }), { status });
  };

const USER = { __typename: 'User', login: 'Reviewer' };

test('given permissions write, admin, read and none, when each user is looked up, then only write and admin are maintainers', async () => {
  for (const [permission, expected] of [
    ['write', true],
    ['admin', true],
    ['read', false],
    ['none', false],
  ] as const) {
    const lookup = maintainerLookup(answering(200, permission)([]), 't', 'rameezk/forge');
    assert.equal(await lookup(USER), expected, permission);
  }
});

test('given a user GitHub does not know, when they are looked up, then they are not a maintainer', async () => {
  const lookup = maintainerLookup(answering(404)([]), 't', 'rameezk/forge');
  assert.equal(await lookup(USER), false);
});

test('given a bot or a deleted account, when looked up, then they are not a maintainer and GitHub is not asked', async () => {
  const requests: string[] = [];
  const lookup = maintainerLookup(answering(200, 'admin')(requests), 't', 'rameezk/forge');
  assert.equal(await lookup({ __typename: 'Bot', login: 'forge' }), false);
  assert.equal(await lookup(null), false);
  assert.deepEqual(requests, []);
});

test('given the same login in different cases, when looked up twice, then GitHub is asked once', async () => {
  const requests: string[] = [];
  const lookup = maintainerLookup(answering(200, 'write')(requests), 't', 'rameezk/forge');
  await lookup(USER);
  await lookup({ ...USER, login: 'reviewer' });
  assert.deepEqual(requests, ['/repos/rameezk/forge/collaborators/Reviewer/permission']);
});

test('given GitHub answers 500, when a user is looked up, then it throws, and a later lookup asks again', async () => {
  const requests: string[] = [];
  const lookup = maintainerLookup(answering(500)(requests), 't', 'rameezk/forge');
  await assert.rejects(lookup(USER), /500/);
  await assert.rejects(lookup(USER), /500/);
  assert.equal(requests.length, 2);
});
