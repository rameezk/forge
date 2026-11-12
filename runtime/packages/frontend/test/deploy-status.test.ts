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

const unknownForge = { bumpError: null, forge: null, upstream: null, upstreamHead: null, behind: null };

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

const errorBoxOf = (body: string): string => {
  const box = body.match(/<[^>]*\sdata-deploy-error[^>]*>[\s\S]*?<\/[a-z]+>/)?.[0];
  assert.ok(box, 'the Board shows the deploy error box');
  return box;
};

const failing = (error: string): DeployStatus => ({ running: RUNNING, head: HEAD, error, ...unknownForge });

test('given a deploy status with an error, when the Board is requested, then it shows the error output in a box the footer pill can link to', async () => {
  const box = errorBoxOf(await boardWith(() => failing('building the system failed')));

  assert.match(openingTag(box), /\sid="deploy-error"/);
  assert.match(textOf(box), /building the system failed/);
});

test('given a deploy status with no error, when the Board is requested, then there is no deploy row and no error box', async () => {
  for (const status of [{ running: RUNNING, head: RUNNING, error: null, ...unknownForge }, { running: null, head: HEAD, error: null, ...unknownForge }]) {
    const body = await boardWith(() => status);

    assert.doesNotMatch(body, /data-deploy-status|data-deploy-error|data-deploy-current|id="deploy-error"/);
    assert.doesNotMatch(textOf(body), /Running [0-9a-f]{7}|Running unknown|up to date/);
  }
});

test('given no deploy status, when the Board is requested, then it shows no deploy error box', async () => {
  assert.doesNotMatch(await boardWith(), /data-deploy-error/);
  assert.doesNotMatch(await boardWith(() => null), /data-deploy-error/);
});

test('given a deploy status error with markup, when the Board is requested, then the error is escaped', async () => {
  const body = await boardWith(() => failing('<script>alert(1)</script>'));

  assert.doesNotMatch(body, /<script>alert/);
  assert.match(errorBoxOf(body), /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('given the record the pull deploy writes, when it is read, then running, head and error come through, with null for each that is unknown', () => {
  assert.deepEqual(parseDeployStatus(JSON.stringify({ running: RUNNING, head: HEAD, error: 'boom' })), { running: RUNNING, head: HEAD, error: 'boom', ...unknownForge });
  assert.deepEqual(parseDeployStatus('{"running":null,"head":null,"error":null}'), { running: null, head: null, error: null, ...unknownForge });
  assert.deepEqual(parseDeployStatus('{}'), { running: null, head: null, error: null, ...unknownForge });
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
  assert.deepEqual(readDeployStatus(file), { running: RUNNING, head: RUNNING, error: null, ...unknownForge });
});

test('given a deploy status that changes, when the Board is rendered again, then its live version changes', async () => {
  let status: DeployStatus | null = { running: RUNNING, head: RUNNING, error: null, ...unknownForge };
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
  status = { running: RUNNING, head: HEAD, error: null, ...unknownForge };

  assert.notEqual(before, undefined);
  assert.notEqual(await versionOf(), before);
});

test('given a multi-line switch error, when the Board is requested, then the error keeps its line breaks and is not cut to one line', async () => {
  const error = 'error: builder for drv failed\nlast 20 lines of the log';
  const box = errorBoxOf(await boardWith(() => failing(error)));

  const tag = openingTag(box.match(/<[^>]*\sdata-deploy-error[^>]*>/)?.[0] ?? '');
  assert.match(tag, /whitespace-pre-line/);
  assert.doesNotMatch(tag, /\struncate\b|line-clamp/);
});

const bumpBoxOf = (body: string): string => {
  const box = body.match(/<[^>]*\sdata-bump-error[^>]*>[\s\S]*?<\/[a-z]+>/)?.[0];
  assert.ok(box, 'the Board shows the bump error box');
  return box;
};

const classOf = (tag: string): string | undefined => /\sclass="([^"]*)"/.exec(openingTag(tag))?.[1];

test('given a status with a bump error, when the Board is requested, then it shows the bump error styled like the switch error and no switch error', async () => {
  const body = await boardWith(() => ({ running: RUNNING, head: RUNNING, error: null, ...unknownForge, bumpError: 'Resource not accessible by integration' }));

  const box = bumpBoxOf(body);
  assert.match(textOf(box), /Resource not accessible by integration/);
  assert.match(textOf(box), /bump/i);
  assert.doesNotMatch(body, /data-deploy-error/);
  const reference = errorBoxOf(await boardWith(() => failing('x')));
  assert.equal(classOf(box), classOf(reference));
});

test('given a status with both a switch error and a bump error, when the Board is requested, then each is shown in its own box', async () => {
  const body = await boardWith(() => ({ ...failing('building the system failed'), bumpError: 'dispatch refused' }));

  assert.match(textOf(errorBoxOf(body)), /building the system failed/);
  assert.doesNotMatch(textOf(errorBoxOf(body)), /dispatch refused/);
  assert.match(textOf(bumpBoxOf(body)), /dispatch refused/);
  assert.doesNotMatch(textOf(bumpBoxOf(body)), /building the system failed/);
});

test('given a status with no bump error, when the Board is requested, then there is no bump error box', async () => {
  assert.doesNotMatch(await boardWith(() => failing('boom')), /data-bump-error/);
  assert.doesNotMatch(await boardWith(), /data-bump-error/);
});

test('given a bump error with markup, when the Board is requested, then it is escaped', async () => {
  const body = await boardWith(() => ({ ...failing('x'), bumpError: '<script>alert(1)</script>' }));

  assert.doesNotMatch(body, /<script>alert/);
  assert.match(bumpBoxOf(body), /&lt;script&gt;/);
});

test('given a record with a bump error, when it is read, then bumpError comes through', () => {
  assert.equal(parseDeployStatus('{"bumpError":"nope"}')?.bumpError, 'nope');
});
