import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cachedTokens, GithubApp } from '../src/index.ts';
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
  ['read', { issues: 'read', pull_requests: 'read', contents: 'read', checks: 'read', statuses: 'read' }],
  ['write', { issues: 'write', pull_requests: 'read', contents: 'read', checks: 'read', statuses: 'read' }],
  [
    'workload',
    {
      contents: 'write',
      issues: 'write',
      pull_requests: 'write',
      workflows: 'write',
      checks: 'read',
      actions: 'read',
      statuses: 'read',
    },
  ],
] as const) {
  test(`given an installed repository, when a ${access} token is minted, then GitHub is asked for exactly its permissions`, async () => {
    const github = fakeGithubApp();

    await appOn(github).mint(INSTALLED, access);

    assert.deepEqual(github.mints[0]?.body.permissions, permissions);
  });
}

test('given an installation that has not granted a permission forge requests, when a token is minted, then it fails naming the permissions forge requested and what GitHub answered', async () => {
  const github = fakeGithubApp();
  const refusing: typeof globalThis.fetch = async (input, init) =>
    init?.method === 'POST'
      ? new Response(
          '{"message":"The permissions requested are not granted to this installation."}',
          { status: 422 },
        )
      : github.fetch(input, init);

  await assert.rejects(appOn({ ...github, fetch: refusing }).mint(INSTALLED, 'read'), {
    message:
      'GitHub refused a read token for rameezk/forge-app-test with the permissions forge requested (issues: read, pull_requests: read, contents: read, checks: read, statuses: read): GitHub answered 422: The permissions requested are not granted to this installation.',
  });
  assert.equal(github.mints.length, 0);
});

test('given GitHub answers a token that cannot be a header value, when a token is minted, then it fails instead of handing the token on', async () => {
  const github = fakeGithubApp();
  const tampered: typeof globalThis.fetch = async (input, init) => {
    const response = await github.fetch(input, init);
    if (init?.method !== 'POST') return response;
    const body = (await response.json()) as Record<string, unknown>;
    return new Response(JSON.stringify({ ...body, token: 'ghs_one\r\nX-Injected: 1' }), {
      status: response.status,
    });
  };

  await assert.rejects(
    appOn({ ...github, fetch: tampered }).mint(INSTALLED, 'read'),
    { message: `GitHub returned a malformed installation token for ${INSTALLED}` },
  );
});

test('given a mint that failed once, when the same token is asked for again, then it is minted afresh instead of the failure being replayed', async () => {
  const github = fakeGithubApp();
  let failing = true;
  const flaky: typeof globalThis.fetch = async (input, init) =>
    failing ? new Response('{"message":"Bad gateway"}', { status: 502 }) : github.fetch(input, init);
  const tokens = cachedTokens(appOn({ ...github, fetch: flaky }));

  await assert.rejects(tokens(INSTALLED, 'read'), { message: 'GitHub answered 502: Bad gateway' });
  failing = false;
  assert.equal(await tokens(INSTALLED, 'read'), tokenFor('read', INSTALLED));
  assert.equal(await tokens(INSTALLED, 'read'), tokenFor('read', INSTALLED));
  assert.equal(github.mints.length, 1);
});

const appJwt = async (github: ReturnType<typeof fakeGithubApp>): Promise<string> => {
  await appOn(github).mint(INSTALLED, 'read');
  return github.mints[0]?.jwt ?? '';
};

test('given the stricter fake, when the App signs a request to a route outside /app, then GitHub answers 401 Bad credentials', async () => {
  const github = fakeGithubApp();

  const response = await github.fetch(`https://api.github.com/repos/${INSTALLED}/issues`, {
    headers: { authorization: `Bearer ${await appJwt(github)}` },
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { message: 'Bad credentials' });
});

test('given the stricter fake, when an installation token is sent to an /app route, then GitHub answers 401 Bad credentials', async () => {
  const github = fakeGithubApp();
  const { token } = await appOn(github).mint(INSTALLED, 'read');

  const response = await github.fetch('https://api.github.com/app', {
    headers: { authorization: `Bearer ${token}` },
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { message: 'Bad credentials' });
});
