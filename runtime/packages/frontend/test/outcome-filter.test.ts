import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import type { RunRecord, RunStatus } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { textOf } from './html.ts';

const sampleRun = (id: string, status: RunStatus): RunRecord => ({
  id,
  worker: 'builder',
  harness: 'pi',
  model: 'z-ai/glm-5',
  reasoningEffort: 'high',
  startTime: '2026-09-21T10:00:00.000Z',
  endTime: status === 'running' ? null : '2026-09-21T10:03:20.000Z',
  status,
  costStatus: 'billed',
  costUsd: 0.1234,
  costEstimated: false,
  unconfirmedEstimateUsd: 0,
  listPrice: null,
  inputTokens: 4200,
  outputTokens: 850,
  cacheReadTokens: 800,
  cacheWriteTokens: 200,
  transcriptRef: null,
  sessionId: null,
  error: null,
  ticket: null,
  aliveAt: null,
  harnessStartTime: null,
  timeoutSeconds: 7200,
  maxCostUsd: null,
  exceededLimit: null,
  counters: { toolCalls: 12, failedToolResults: 2, retries: 1, compactions: 0 },
});

const issue = (number: number) => ({ repository: 'forge', number, url: `https://github.com/rameezk/forge/issues/${number}` });

const appOver = (store: Store) =>
  createApp({ store, transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))), css: '', logo: '', idiomorph: '', client: '' });

const dashboard = () => {
  const store = Store.open(':memory:');
  const dispatch = (id: string, status: RunStatus, number: number, outcome?: Parameters<Store['endDispatch']>[1]) => {
    store.insertRun(sampleRun(id, status));
    const started = store.startDispatch(issue(number), id, outcome === undefined ? new Date().toISOString() : '2026-09-21T10:00:00.000Z', 10);
    assert.ok('started' in started);
    if (outcome !== undefined) store.endDispatch(started.started, outcome, '2026-09-21T10:03:20.000Z');
  };
  dispatch('done-dispatch', 'success', 1, { state: 'done', pullRequest: { number: 101, url: 'https://github.com/rameezk/forge/pull/101' } });
  dispatch('draft-dispatch', 'success', 2, { state: 'failed', reason: 'draft', detail: null });
  dispatch('running-dispatch', 'running', 3);
  store.insertRun(sampleRun('plain-interrupted', 'interrupted'));
  store.insertRun(sampleRun('plain-success', 'success'));
  return appOver(store);
};

const open = async (path: string): Promise<string> => (await dashboard().request(path)).text();
const chip = (page: string, key: string): string =>
  textOf(page.match(new RegExp(`<a[^>]*\\sdata-status-chip="${key}"[^>]*>[\\s\\S]*?</a>`))?.[0] ?? 'missing');
const chips = (page: string): string[] => [...page.matchAll(/\sdata-status-chip="([^"]*)"/g)].map(([, key]) => key!);
const listed = (page: string): string[] => [...page.matchAll(/<tr[^>]*\sdata-run="([^"]*)"/g)].map(([, id]) => id!).sort();

test('given any runs, when the workloads list opens, then the chips are all, running, done and failed with their counts', async () => {
  const page = await open('/workloads');
  assert.deepEqual(chips(page), ['all', 'running', 'done', 'failed']);
  assert.equal(chip(page, 'running'), 'Running 1');
  assert.equal(chip(page, 'done'), 'Done 2');
  assert.equal(chip(page, 'failed'), 'Failed 2');
});

test('given a successful run whose dispatch failed on a draft and an interrupted run with no workload, when the failed chip is picked, then both are listed', async () => {
  assert.deepEqual(listed(await open('/workloads?status=failed')), ['draft-dispatch', 'plain-interrupted']);
});

test('given a successful run with no workload, when the done chip is picked, then it is listed with the done dispatch and not the interrupted run', async () => {
  assert.deepEqual(listed(await open('/workloads?status=done')), ['done-dispatch', 'plain-success']);
});

test('given a dispatch still in progress, when the running chip is picked, then it is listed', async () => {
  assert.deepEqual(listed(await open('/workloads?status=running')), ['running-dispatch']);
});

test('given successful runs whose revision failed, whose conflict resolution failed and whose revision is done, when the failed chip is picked, then only the failed ones are listed', async () => {
  const store = Store.open(':memory:');
  const pull = (number: number) => ({ repository: 'forge', number, url: `https://github.com/rameezk/forge/pull/${number}` });
  store.insertRun(sampleRun('revision-failed', 'success'));
  const failedRevision = store.startRevision(pull(1), [], 'revision-failed', '2026-09-21T10:00:00.000Z', 10);
  assert.ok('started' in failedRevision);
  store.endRevision(failedRevision.started, 'failed', '2026-09-21T10:03:20.000Z', { reason: 'unanswered', detail: null });
  store.insertRun(sampleRun('resolution-failed', 'success'));
  const failedResolution = store.startConflictResolution(pull(2), [], 'resolution-failed', '2026-09-21T10:00:00.000Z', 10, { headSha: 'head', defaultSha: 'default' });
  assert.ok('started' in failedResolution);
  store.endConflictResolution(failedResolution.started, 'failed', '2026-09-21T10:03:20.000Z', { reason: 'still-conflicting', detail: null });
  store.insertRun(sampleRun('revision-done', 'success'));
  const doneRevision = store.startRevision(pull(3), [], 'revision-done', '2026-09-21T10:00:00.000Z', 10);
  assert.ok('started' in doneRevision);
  store.endRevision(doneRevision.started, 'done', '2026-09-21T10:03:20.000Z');

  const page = await (await appOver(store).request('/workloads?status=failed')).text();

  assert.deepEqual(listed(page), ['resolution-failed', 'revision-failed']);
});
