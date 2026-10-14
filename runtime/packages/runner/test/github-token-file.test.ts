import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitEnvironment } from '../src/git.ts';
import { GITHUB_TOKEN_FILE_ENV, GithubTokenFile } from '../src/github-token-file.ts';

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
