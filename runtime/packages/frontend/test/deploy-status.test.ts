import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createApp, FileTranscriptSource, parseDeployStatus, readDeployStatus } from '../src/index.ts';
import type { DeployStatus } from '../src/index.ts';
import { openingTag, textOf } from './html.ts';

const RUNNING = '1111111111111111111111111111111111111111';
const HEAD = '2222222222222222222222222222222222222222';

const boardWith = async (deployStatus?: () => DeployStatus | null): Promise<string> => {
  const app = createApp({
    store: Store.open(':memory:'),
    transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))),
    css: '',
    logo: '',
    idiomorph: '',
    client: '',
    ...(deployStatus === undefined ? {} : { deployStatus }),
  });
  return (await app.request('/')).text();
};

const sectionOf = (body: string): string => {
  const section = body.match(/<section[^>]*\sdata-deploy-status[^>]*>[\s\S]*?<\/section>/)?.[0];
  assert.ok(section, 'the Board shows the deploy status');
  return section;
};

const words = (fragment: string): string => textOf(fragment).replace(/\s+/g, ' ').trim();

test('given a deploy status with a running commit, a different head commit and a last switch error, when the Board is requested, then it shows the running commit, the head commit and the error', async () => {
  const section = sectionOf(await boardWith(() => ({ running: RUNNING, head: HEAD, error: 'building the system failed' })));

  assert.match(words(section), /Running 1111111/);
  assert.match(words(section), /Head 2222222/);
  assert.match(section, /<[^>]*\sdata-deploy-error[^>]*>[^<]*building the system failed/);
  assert.doesNotMatch(section, /data-deploy-current/);
});

test('given a deploy status whose running and head commits match with no error, when the Board is requested, then it shows the running commit as current and no error', async () => {
  const section = sectionOf(await boardWith(() => ({ running: RUNNING, head: RUNNING, error: null })));

  assert.match(words(section), /Running 1111111/);
  assert.match(words(section), /up to date/);
  assert.match(section, /data-deploy-current/);
  assert.doesNotMatch(section, /data-deploy-error/);
  assert.doesNotMatch(words(section), /Head/);
});

test('given a deploy status that has never recorded a running commit, when the Board is requested, then it shows the running commit as unknown', async () => {
  const section = sectionOf(await boardWith(() => ({ running: null, head: HEAD, error: null })));

  assert.match(words(section), /Running unknown/);
  assert.match(words(section), /Head 2222222/);
});

test('given no deploy status, when the Board is requested, then it shows no deploy status', async () => {
  assert.doesNotMatch(await boardWith(), /data-deploy-status/);
  assert.doesNotMatch(await boardWith(() => null), /data-deploy-status/);
});

test('given a deploy status error with markup, when the Board is requested, then the error is escaped', async () => {
  const body = await boardWith(() => ({ running: RUNNING, head: HEAD, error: '<script>alert(1)</script>' }));

  assert.doesNotMatch(body, /<script>alert/);
  assert.match(sectionOf(body), /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('given the record the pull deploy writes, when it is read, then running, head and error come through, with null for each that is unknown', () => {
  assert.deepEqual(parseDeployStatus(JSON.stringify({ running: RUNNING, head: HEAD, error: 'boom' })), { running: RUNNING, head: HEAD, error: 'boom' });
  assert.deepEqual(parseDeployStatus('{"running":null,"head":null,"error":null}'), { running: null, head: null, error: null });
  assert.deepEqual(parseDeployStatus('{}'), { running: null, head: null, error: null });
});

test('given a record that is not a JSON object, when it is read, then there is no deploy status', () => {
  assert.equal(parseDeployStatus(''), null);
  assert.equal(parseDeployStatus('{"running":'), null);
  assert.equal(parseDeployStatus('[]'), null);
  assert.equal(parseDeployStatus('"x"'), null);
});

test('given a status file that does not exist or exists, when it is read, then there is no deploy status or the recorded one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-deploy-status-'));
  const file = join(dir, 'status.json');
  assert.equal(readDeployStatus(file), null);
  writeFileSync(file, JSON.stringify({ running: RUNNING, head: RUNNING, error: null }));
  assert.deepEqual(readDeployStatus(file), { running: RUNNING, head: RUNNING, error: null });
});

test('given a deploy status that changes, when the Board is rendered again, then its live version changes', async () => {
  let status: DeployStatus | null = { running: RUNNING, head: RUNNING, error: null };
  const app = createApp({
    store: Store.open(':memory:'),
    transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))),
    css: '',
    logo: '',
    idiomorph: '',
    client: '',
    deployStatus: () => status,
  });
  const versionOf = async (): Promise<string | undefined> => /<span id="live"[^>]* data-version="([^"]*)"/.exec(await (await app.request('/')).text())?.[1];

  const before = await versionOf();
  status = { running: RUNNING, head: HEAD, error: null };

  assert.notEqual(before, undefined);
  assert.notEqual(await versionOf(), before);
});

test('given a multi-line switch error, when the Board is requested, then the error keeps its line breaks and is not cut to one line', async () => {
  const error = 'error: builder for drv failed\nlast 20 lines of the log';
  const section = sectionOf(await boardWith(() => ({ running: RUNNING, head: HEAD, error })));

  const tag = openingTag(section.match(/<[^>]*\sdata-deploy-error[^>]*>/)?.[0] ?? '');
  assert.match(tag, /whitespace-pre-line/);
  assert.doesNotMatch(tag, /\struncate\b|line-clamp/);
});
