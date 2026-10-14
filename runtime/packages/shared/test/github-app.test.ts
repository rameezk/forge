import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GithubApp } from '../src/index.ts';
import { APP_ID, fakeGithubApp, INSTALLED, tokenFor } from './fixtures/fake-github-app.ts';

const appOn = (github: ReturnType<typeof fakeGithubApp>): GithubApp =>
  new GithubApp({
    appId: APP_ID,
    privateKey: github.privateKey,
    fetch: github.fetch,
    now: () => github.now.value ?? Date.now(),
  });

test('given a repository the App is installed on, when a read token is minted, then GitHub is asked for a token on that repository alone and the token comes back with its expiry', async () => {
  const github = fakeGithubApp();
  github.now.value = Date.parse('2026-10-14T10:00:00Z');

  const minted = await appOn(github).mint(INSTALLED, 'read');

  assert.deepEqual(minted, {
    token: tokenFor('read', INSTALLED),
    expiresAt: '2026-10-14T11:00:00Z',
  });
  assert.equal(github.mints.length, 1);
  assert.deepEqual(github.mints[0]?.body.repositories, ['forge-app-test']);
});

test('given a repository the App is not installed on, when a token is minted for it, then it fails saying the App is not installed on that repository and mints nothing', async () => {
  const github = fakeGithubApp();

  await assert.rejects(
    appOn(github).mint('rameezk/forge-app-test-uninstalled', 'read'),
    { message: 'the GitHub App is not installed on rameezk/forge-app-test-uninstalled' },
  );
  assert.equal(github.mints.length, 0);
});

test('given an App whose private key is not the one GitHub knows, when a token is minted, then it fails with what GitHub answered and mints nothing', async () => {
  const github = fakeGithubApp();
  const other = fakeGithubApp();

  await assert.rejects(
    appOn({ ...github, privateKey: other.privateKey }).mint(INSTALLED, 'read'),
    { message: 'GitHub answered 401: A JSON web token could not be decoded' },
  );
  assert.equal(github.mints.length, 0);
});

for (const [access, permissions] of [
  ['read', { issues: 'read', pull_requests: 'read' }],
  ['write', { issues: 'write', pull_requests: 'read' }],
  [
    'workload',
    { contents: 'write', issues: 'write', pull_requests: 'write', workflows: 'write' },
  ],
] as const) {
  test(`given an installed repository, when a ${access} token is minted, then GitHub is asked for exactly its permissions`, async () => {
    const github = fakeGithubApp();

    await appOn(github).mint(INSTALLED, access);

    assert.deepEqual(github.mints[0]?.body.permissions, permissions);
  });
}
