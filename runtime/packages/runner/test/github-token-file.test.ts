import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitEnvironment } from '../src/git.ts';
import { GITHUB_TOKEN_FILE_ENV, GithubTokenFile, keepFresh } from '../src/github-token-file.ts';

const IDENTITY = { name: 'Forge Operator', email: 'operator@example.com' };

const credentialFor = (file: GithubTokenFile): string =>
  execFileSync('git', ['credential', 'fill'], {
    env: {
      PATH: process.env.PATH ?? '',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: tmpdir(),
      ...file.environment,
      ...gitEnvironment({}, IDENTITY),
    },
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });

const open = (token: string, redactions: string[] = []): GithubTokenFile =>
  GithubTokenFile.create(mkdtempSync(join(tmpdir(), 'forge-credentials-')), 'run-1', token, redactions);

test('given a token, when its file is created, then only the runner can read it, the environment names it, and the redaction list holds the token', () => {
  const redactions: string[] = [];
  const file = open('github_pat_first', redactions);

  assert.equal(file.environment[GITHUB_TOKEN_FILE_ENV], file.path);
  assert.equal(readFileSync(file.path, 'utf8'), 'github_pat_first');
  assert.equal(statSync(file.path).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(file.path)).mode & 0o777, 0o700);
  assert.deepEqual(redactions, ['github_pat_first']);
});

test('given a created token file, when git asks for GitHub credentials, then it answers with the file\'s token', () => {
  const file = open('github_pat_first');

  assert.match(credentialFor(file), /^password=github_pat_first$/m);
});

test('given a running workload whose token file is replaced, when git next asks for GitHub credentials, then it gets the new token and both tokens are redacted', () => {
  const redactions: string[] = [];
  const file = open('github_pat_first', redactions);

  file.replace('github_pat_second');

  assert.match(credentialFor(file), /^password=github_pat_second$/m);
  assert.deepEqual(redactions, ['github_pat_first', 'github_pat_second']);
  assert.deepEqual(
    execFileSync('ls', ['-A', dirname(file.path)], { encoding: 'utf8' }).split('\n').filter(Boolean),
    ['github-token'],
  );
});

test('given a token file, when it is removed, then its directory is gone', () => {
  const file = open('github_pat_first');

  file.remove();

  assert.equal(existsSync(dirname(file.path)), false);
});

test('given a token file that is gone, when git asks for GitHub credentials, then it fails instead of answering with an empty password', () => {
  const file = open('github_pat_first');
  file.remove();

  assert.throws(() => credentialFor(file));
});

const HOUR = 3_600_000;

const expiringIn = (ms: number, now: number): string => new Date(now + ms).toISOString();

test('given a token file kept fresh, when half of the token\'s life has passed, then the file holds the next token and both are redacted', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const redactions: string[] = [];
  const file = open('first', redactions);
  const stop = keepFresh(
    file,
    { token: 'first', expiresAt: expiringIn(HOUR, 0) },
    async () => ({ token: 'second', expiresAt: expiringIn(2 * HOUR, Date.now()) }),
    () => assert.fail('the refresh failed'),
  );
  context.mock.timers.tick(HOUR / 2 - 1);
  assert.equal(readFileSync(file.path, 'utf8'), 'first');
  context.mock.timers.tick(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  stop();
  assert.equal(readFileSync(file.path, 'utf8'), 'second');
  assert.deepEqual(redactions, ['first', 'second']);
});

test('given a refresh that keeps failing, when the token has long expired, then it retries with a growing delay instead of every second, and recovers', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const file = open('first');
  const failures: unknown[] = [];
  let attempts = 0;
  const stop = keepFresh(
    file,
    { token: 'first', expiresAt: expiringIn(1000, 0) },
    async () => {
      attempts += 1;
      if (attempts <= 6) throw new Error('GitHub is down');
      return { token: 'second', expiresAt: expiringIn(HOUR, Date.now()) };
    },
    (error) => failures.push(error),
  );
  const settle = async (ms: number): Promise<void> => {
    context.mock.timers.tick(ms);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const attemptsAt: number[] = [];
  let elapsed = 0;
  for (const until of [999, 1000, 1999, 2000, 3999, 4000, 7999, 8000, 15_999, 16_000, 31_999, 32_000, 63_999, 64_000]) {
    await settle(until - elapsed);
    elapsed = until;
    attemptsAt.push(attempts);
  }
  assert.deepEqual(attemptsAt, [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7]);
  stop();
  assert.equal(failures.length, 6);
  assert.equal(readFileSync(file.path, 'utf8'), 'second');
});

test('given a refresh that cannot write the token file, when the next token arrives, then the failure is reported and the process survives', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const file = open('first');
  file.remove();
  const failures: unknown[] = [];
  const stop = keepFresh(
    file,
    { token: 'first', expiresAt: expiringIn(HOUR, 0) },
    async () => ({ token: 'second', expiresAt: expiringIn(HOUR, Date.now()) }),
    (error) => failures.push(error),
  );
  context.mock.timers.tick(HOUR / 2);
  await new Promise<void>((resolve) => setImmediate(resolve));
  stop();
  assert.equal(failures.length, 1);
});

test('given a stopped refresher, when its timer would have fired, then it mints nothing', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const file = open('first');
  const stop = keepFresh(
    file,
    { token: 'first', expiresAt: expiringIn(HOUR, 0) },
    async () => assert.fail('minted after stop'),
    () => assert.fail('the refresh failed'),
  );
  stop();
  context.mock.timers.tick(HOUR);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(readFileSync(file.path, 'utf8'), 'first');
});
