import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { textOf } from './html.ts';

const REPOSITORY = { repository: 'forge', github: 'rameezk/forge' };
const ISSUE = { repository: 'forge', number: 42, url: 'https://github.com/rameezk/forge/issues/42' };
const PULL_REQUEST = { repository: 'forge', number: 9, url: 'https://github.com/rameezk/forge/pull/9' };

const boardAt = (store: Store, now: string) =>
  createApp({
    store,
    transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))),
    css: '',
    logo: '',
    idiomorph: '',
    client: '',
    clock: () => new Date(now),
  });

const seedTicket = (store: Store, overrides: { forgeReady?: boolean } = {}): void => {
  store.frontier.replaceFrontier({
    ...REPOSITORY,
    polledAt: '2026-09-29T08:15:00.000Z',
    closed: [],
    requests: [],
    tickets: [{ number: 42, title: 'Ticket', url: ISSUE.url, parent: null, createdAt: '2026-09-28T10:07:58Z', forgeReady: overrides.forgeReady ?? true, forHuman: false, blocked: false, blockedBy: [], assignees: [] }],
  });
};

const cardOf = (board: string): string => /<article[^>]*\sdata-ticket="42"[\s\S]*?<\/article>/.exec(board)![0];

const columnOf = (board: string, key: string): string =>
  new RegExp(`<div data-column="${key}"[\\s\\S]*?(?=<div data-column=|</section>)`).exec(board)![0];

test('given a ticket whose dispatch failed to start twice, last at a known instant, and a clock fixed 2h 5m later, when the Board is requested, then its card reads Did not start with exactly that elapsed time', async () => {
  const store = Store.open(':memory:');
  seedTicket(store);
  store.workloads.recordFailedStart(ISSUE, 'first', '2026-09-25T09:00:00.000Z');
  store.workloads.recordFailedStart(ISSUE, 'second', '2026-09-25T10:00:00.000Z');

  const board = await (await boardAt(store, '2026-09-25T12:05:00.000Z').request('/')).text();

  assert.match(textOf(cardOf(board)), /Did not start \(2 times, last 2h 5m ago\)/);
});

test('given a ticket whose pull request had a conflict resolution fail to start twice, last at a known instant, and a clock fixed 3h 1m later, when the Board is requested, then its card reads Conflict resolution did not start with exactly that elapsed time', async () => {
  const store = Store.open(':memory:');
  seedTicket(store);
  const started = store.workloads.startDispatch(ISSUE, 'run-1', '2026-09-24T10:00:00.000Z', 10, null);
  assert.ok('started' in started);
  store.workloads.endDispatch(started.started, { state: 'done', pullRequest: { number: 9, url: PULL_REQUEST.url } }, '2026-09-24T10:30:00.000Z');
  for (const at of ['2026-09-25T09:00:00.000Z', '2026-09-25T10:00:00.000Z']) {
    const attempt = store.workloads.startConflictResolution(PULL_REQUEST, [42], `unused-${at}`, at, 10, { headSha: 'head-a', defaultSha: 'default-a' });
    assert.ok('started' in attempt);
    store.workloads.failConflictResolutionStart(attempt.started, 'clone failed', at);
  }

  const board = await (await boardAt(store, '2026-09-25T13:01:00.000Z').request('/')).text();

  assert.match(textOf(cardOf(board)), /Conflict resolution did not start \(2 times, last 3h 1m ago\)/);
});

test('given a running dispatch last alive at a known instant, when the Board is requested with the clock before and after the liveness cutoff, then the ticket is in Running only before it', async () => {
  const store = Store.open(':memory:');
  seedTicket(store);
  const started = store.workloads.startDispatch(ISSUE, 'run-1', '2026-09-25T10:00:00.000Z', 10, null);
  assert.ok('started' in started);

  const before = await (await boardAt(store, '2026-09-25T10:01:00.000Z').request('/')).text();
  const after = await (await boardAt(store, '2026-09-25T10:10:00.000Z').request('/')).text();

  assert.match(columnOf(before, 'running'), /data-ticket="42"/);
  assert.doesNotMatch(columnOf(after, 'running'), /data-ticket="42"/);
  assert.match(columnOf(after, 'failed'), /data-ticket="42"/);
});
