import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import type { DispatchOutcome, RunRecord, RunStatus } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { textOf } from './html.ts';

const GITHUB = 'https://github.com/rameezk/';

const sampleRun = (id: string, status: RunStatus, ticketNumber: number | null): RunRecord => ({
  id,
  worker: 'builder',
  harness: 'pi',
  model: 'z-ai/glm-5',
  reasoningEffort: 'high',
  startTime: status === 'running' ? new Date().toISOString() : '2026-09-21T10:00:00.000Z',
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
  ticket: ticketNumber === null ? null : { repository: 'forge', number: ticketNumber, url: `${GITHUB}forge/issues/${ticketNumber}` },
  aliveAt: null,
  harnessStartTime: null,
  timeoutSeconds: 7200,
  maxCostUsd: null,
  exceededLimit: null,
  counters: { toolCalls: 12, failedToolResults: 2, retries: 1, compactions: 0 },
});

const dispatchRun = (store: Store, id: string, status: RunStatus, number: number, outcome?: DispatchOutcome): void => {
  store.insertRun(sampleRun(id, status, number));
  const started = store.startDispatch({ repository: 'forge', number, url: `${GITHUB}forge/issues/${number}` }, id, status === 'running' ? new Date().toISOString() : '2026-09-21T10:00:00.000Z', 10);
  assert.ok('started' in started);
  if (outcome !== undefined) store.endDispatch(started.started, outcome, '2026-09-21T10:03:20.000Z');
};

const dashboard = () => {
  const store = Store.open(':memory:');
  dispatchRun(store, 'clean', 'success', 1, { state: 'done', pullRequest: { number: 11, url: `${GITHUB}forge/pull/11` } });
  dispatchRun(store, 'draft', 'success', 2, { state: 'failed', reason: 'draft', detail: null });
  dispatchRun(store, 'stopped', 'interrupted', 3, { state: 'failed', reason: 'interrupted', detail: null });
  dispatchRun(store, 'errored', 'error', 4, { state: 'failed', reason: 'errored', detail: null });
  dispatchRun(store, 'going', 'running', 5);
  store.insertRun(sampleRun('over', 'exceeded', null));
  const revision = store.startRevision({ repository: 'forge', number: 9, url: `${GITHUB}forge/pull/9` }, [], 'over', '2026-09-21T10:00:00.000Z', 10);
  assert.ok('started' in revision);
  store.endRevision(revision.started, 'failed', '2026-09-21T10:03:20.000Z', { reason: 'exceeded', detail: 'budget' });
  store.insertRun(sampleRun('conflicted', 'success', null));
  const resolution = store.startConflictResolution({ repository: 'forge', number: 8, url: `${GITHUB}forge/pull/8` }, [], 'conflicted', '2026-09-21T10:00:00.000Z', 10, { headSha: 'head', defaultSha: 'default' });
  assert.ok('started' in resolution);
  store.endConflictResolution(resolution.started, 'failed', '2026-09-21T10:03:20.000Z', { reason: 'still-conflicting', detail: null });
  store.insertRun(sampleRun('plain', 'success', null));
  store.insertRun(sampleRun('plain-stopped', 'interrupted', null));
  return createApp({ store, transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))), css: '', logo: '', idiomorph: '', client: '' });
};

const row = (page: string, id: string): string => page.match(new RegExp(`<tr[^>]*\\sdata-run="${id}"[\\s\\S]*?</tr>`))?.[0] ?? 'missing';
const card = (page: string, id: string): string => page.match(new RegExp(`<article[^>]*\\sdata-run-card="${id}"[\\s\\S]*?</article>`))?.[0] ?? 'missing';
const statusCell = (page: string, id: string): string => row(page, id).match(/<td[^>]*>(?:(?!<\/td>)[\s\S])*?data-(?:outcome|status)[\s\S]*?<\/td>/)?.[0] ?? 'missing';
const pills = (html: string): string[] => [...html.matchAll(/<span[^>]*\sdata-(?:outcome|status)="[^"]*"[^>]*>[\s\S]*?<\/span>/g)].map(([pill]) => textOf(pill));

test('given runs ending success, interrupted, error and exceeded with their workloads, when the list is requested, then each run leads with its outcome and shows its run status beside it only when not success', async () => {
  const page = await (await dashboard().request('/workloads')).text();

  assert.deepEqual(pills(statusCell(page, 'clean')), ['done']);
  assert.deepEqual(pills(statusCell(page, 'draft')), ['failed']);
  assert.match(textOf(statusCell(page, 'draft')), /Pull request still a draft/);
  assert.deepEqual(pills(statusCell(page, 'stopped')), ['failed', 'interrupted']);
  assert.deepEqual(pills(statusCell(page, 'errored')), ['failed', 'harness error']);
  assert.deepEqual(pills(statusCell(page, 'over')), ['failed', 'exceeded']);
  assert.match(textOf(statusCell(page, 'over')), /Exceeded: budget/);
  assert.deepEqual(pills(statusCell(page, 'conflicted')), ['failed']);
  assert.deepEqual(pills(statusCell(page, 'going')), ['running']);
});

test('given a run with no workload that ended success, when the list is requested, then it shows a single success pill whose tooltip says the harness finished cleanly', async () => {
  const page = await (await dashboard().request('/workloads')).text();

  assert.deepEqual(pills(statusCell(page, 'plain')), ['success']);
  assert.match(statusCell(page, 'plain'), /title="The harness finished cleanly"/);
});

test('given runs covering each outcome and run status, when the list is requested, then every pill carries a tooltip', async () => {
  const page = await (await dashboard().request('/workloads')).text();
  const tags = [...page.matchAll(/<span[^>]*\sdata-(?:outcome|status)="[^"]*"[^>]*>/g)].map(([tag]) => tag);

  assert.ok(tags.length > 0);
  for (const tag of tags) assert.match(tag, /\stitle="[^"]{10,}"/, tag);
  assert.match(page, /data-status="error"[^>]*title="[^"]*harness/);
});

test('given a conflict resolution run that ended success, when the card is read at phone width, then it matches the table', async () => {
  const page = await (await dashboard().request('/workloads')).text();

  assert.deepEqual(pills(card(page, 'conflicted')), ['failed']);
  assert.match(textOf(card(page, 'conflicted')), /Still conflicting/);
  assert.deepEqual(pills(card(page, 'stopped')), ['failed', 'interrupted']);
});

test('given the same run, when its run page is opened, then the summary leads with failed and its reason and no success pill', async () => {
  const app = dashboard();
  const body = await (await app.request('/runs/conflicted')).text();
  const summary = body.match(/<p[^>]*\sdata-summary[\s>][\s\S]*?<\/p>/)?.[0] ?? 'missing';

  assert.deepEqual(pills(summary), ['failed']);
  assert.match(textOf(body.match(/<(div|details)[^>]*\sdata-reason[\s>][\s\S]*?<\/\1>/)?.[0] ?? ''), /Still conflicting/);
  const stopped = await (await app.request('/runs/stopped')).text();
  assert.deepEqual(pills(stopped.match(/<p[^>]*\sdata-summary[\s>][\s\S]*?<\/p>/)?.[0] ?? ''), ['failed', 'interrupted']);
});

test('given runs that are done, failed and running, when the failed chip is picked, then only failed runs and the interrupted run with no workload list, and chips count outcomes', async () => {
  const app = dashboard();
  const page = await (await app.request('/workloads?status=failed')).text();
  const ids = [...page.matchAll(/<tr[^>]*\sdata-run="([^"]+)"/g)].map(([, id]) => id).sort();

  assert.deepEqual(ids, ['conflicted', 'draft', 'errored', 'over', 'plain-stopped', 'stopped']);
  const chips = [...page.matchAll(/data-status-chip="([^"]+)"[^>]*>\s*(\w+)\s*<span[^>]*>(\d+)/g)].map(([, key, , count]) => `${key}:${count}`);
  assert.deepEqual(chips, ['all:9', 'running:1', 'done:2', 'failed:6']);
  const done = await (await app.request('/workloads?status=done')).text();
  assert.deepEqual([...done.matchAll(/<tr[^>]*\sdata-run="([^"]+)"/g)].map(([, id]) => id).sort(), ['clean', 'plain']);
});

test('given a ticket whose dispatch run ended success and whose revision run was interrupted, when the attempts page is requested, then the revision leads with failed beside interrupted, and every pill has a tooltip', async () => {
  const store = Store.open(':memory:');
  dispatchRun(store, 'built', 'success', 21, { state: 'done', pullRequest: { number: 31, url: `${GITHUB}forge/pull/31` } });
  store.insertRun(sampleRun('revised', 'interrupted', null));
  const revision = store.startRevision({ repository: 'forge', number: 31, url: `${GITHUB}forge/pull/31` }, [], 'revised', '2026-09-21T10:00:00.000Z', 10);
  assert.ok('started' in revision);
  store.endRevision(revision.started, 'failed', '2026-09-21T10:03:20.000Z', { reason: 'interrupted', detail: null });
  const app = createApp({ store, transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))), css: '', logo: '', idiomorph: '', client: '' });
  const page = await (await app.request('/tickets/forge/21')).text();
  const revisionRow = page.match(/<tr[^>]*\sdata-revision="revised"[\s\S]*?<\/tr>/)?.[0] ?? 'missing';

  assert.deepEqual(pills(revisionRow), ['failed', 'interrupted']);
  const tags = [...page.matchAll(/<span[^>]*\sdata-(?:outcome|status)="[^"]*"[^>]*>/g)].map(([tag]) => tag);
  assert.ok(tags.length >= 3);
  for (const tag of tags) assert.match(tag, /\stitle="[^"]{10,}"/, tag);
});
