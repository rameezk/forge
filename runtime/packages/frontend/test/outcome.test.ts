import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import type { RevisionFailureRecord, RunRecord } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { textOf } from './html.ts';

const sampleRun = (id: string): RunRecord => ({
  id,
  worker: 'reviser',
  harness: 'pi',
  model: 'z-ai/glm-5',
  reasoningEffort: 'high',
  startTime: '2026-09-21T10:00:00.000Z',
  endTime: '2026-09-21T10:03:20.000Z',
  status: 'success',
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

const DETAIL = 'https://github.com/rameezk/forge/pull/9#issuecomment-1\nsecond line of the detail';

const dashboard = () => {
  const store = Store.open(':memory:');
  const revise = (runId: string, number: number, state: 'done' | 'failed', failure?: RevisionFailureRecord): void => {
    store.insertRun(sampleRun(runId));
    const start = store.startRevision(
      { repository: 'forge', number, url: `https://github.com/rameezk/forge/pull/${number}` },
      [],
      runId,
      '2026-09-21T10:00:00.000Z',
      10,
    );
    assert.ok('started' in start);
    store.endRevision(start.started, state, '2026-09-21T10:03:20.000Z', failure);
  };
  revise('unanswered', 1, 'failed', { reason: 'unanswered', detail: DETAIL });
  revise('reasonless', 2, 'failed');
  revise('good', 3, 'done');
  store.insertRun(sampleRun('resolving'));
  store.startConflictResolution({ repository: 'forge', number: 4, url: 'https://github.com/rameezk/forge/pull/4' }, [], 'resolving', new Date().toISOString(), 10, { headSha: 'head-a', defaultSha: 'default-a' });
  store.insertRun(sampleRun('resolved'));
  const resolution = store.startConflictResolution({ repository: 'forge', number: 5, url: 'https://github.com/rameezk/forge/pull/5' }, [], 'resolved', '2026-09-21T10:00:00.000Z', 10, { headSha: 'head-b', defaultSha: 'default-b' });
  assert.ok('started' in resolution);
  store.endConflictResolution(resolution.started, 'failed', '2026-09-21T10:03:20.000Z', { reason: 'not-merged', detail: 'abc1234 is missing' });
  return createApp({ store, transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))), css: '', logo: '', idiomorph: '', client: '' });
};

const EXPECTED: [string, string][] = [
  ['unanswered', 'success failed Unanswered: https://github.com/rameezk/forge/pull/9#issuecomment-1'],
  ['reasonless', 'success failed no reason recorded'],
  ['good', 'success done'],
];

test('given runs whose revisions ended with a reason, with no reason, and ok, when the list is requested, then each row shows success with its revision outcome beside it', async () => {
  const body = await (await dashboard().request('/workloads')).text();

  for (const [id, expected] of EXPECTED) {
    const row = body.match(new RegExp(`<tr[^>]*\\sdata-run="${id}"[\\s\\S]*?</tr>`))?.[0] ?? '';
    const cell = row.match(/<td[^>]*>(?:(?!<\/td>)[\s\S])*data-status[\s\S]*?<\/td>/)?.[0] ?? 'missing';
    assert.equal(textOf(cell), expected, id);
    const card = body.match(new RegExp(`<article[^>]*\\sdata-run-card="${id}"[\\s\\S]*?</article>`))?.[0] ?? '';
    assert.ok(textOf(card).includes(expected), id);
  }
});

test('given the same runs, when each run page is requested, then the summary shows success with the revision outcome beside it, the reason sits in its own block, and the Revises link carries the outcome', async () => {
  const app = dashboard();

  for (const [id, expected] of EXPECTED) {
    const body = await (await app.request(`/runs/${id}`)).text();
    const summary = body.match(/<p[^>]*\sdata-summary[\s>][\s\S]*?<\/p>/)?.[0] ?? 'missing';
    const [status, outcome] = expected.split(' ');
    assert.ok(textOf(summary).startsWith([status, outcome].join(' ')), id);
    assert.doesNotMatch(summary, /Unanswered|no reason recorded/, id);
    const revises = body.match(/<dd[^>]*\sdata-revised-pull-request[\s>][\s\S]*?<\/dd>/)?.[0] ?? 'missing';
    assert.match(revises, /\sdata-outcome="(done|failed)"/, id);
  }
});

test('given a conflict resolution that failed and one still running, when the list and run pages are requested, then the failed one shows its outcome and the running one shows none', async () => {
  const app = dashboard();
  const list = await (await app.request('/workloads')).text();
  const row = (id: string): string => list.match(new RegExp(`<tr[^>]*\\sdata-run="${id}"[\\s\\S]*?</tr>`))?.[0] ?? '';

  assert.match(textOf(row('resolved')), /success failed Not merged: abc1234 is missing/);
  assert.doesNotMatch(row('resolving'), /data-outcome=/);
  const page = await (await app.request('/runs/resolved')).text();
  assert.match(textOf(page.match(/<p[^>]*\sdata-summary[\s>][\s\S]*?<\/p>/)?.[0] ?? ''), /^success failed/);
  assert.match(textOf(page.match(/<details[^>]*\sdata-reason[\s>][\s\S]*?<\/details>/)?.[0] ?? ''), /Not merged\s*: abc1234 is missing/);
  assert.doesNotMatch(await (await app.request('/runs/resolving')).text(), /data-outcome=/);
});

test('given a revision that failed as exceeded on its budget and one that failed as interrupted, when the list is requested, then both read failed and the reasons name the budget and the interruption', async () => {
  const store = Store.open(':memory:');
  const stop = (runId: string, number: number, failure: RevisionFailureRecord): void => {
    store.insertRun(sampleRun(runId));
    const start = store.startRevision(
      { repository: 'forge', number, url: `https://github.com/rameezk/forge/pull/${number}` },
      [],
      runId,
      '2026-09-21T10:00:00.000Z',
      10,
    );
    assert.ok('started' in start);
    store.endRevision(start.started, 'failed', '2026-09-21T10:03:20.000Z', failure);
  };
  stop('over', 1, { reason: 'exceeded', detail: 'budget' });
  stop('cut', 2, { reason: 'interrupted', detail: null });
  const body = await (
    await createApp({ store, transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))), css: '', logo: '', idiomorph: '', client: '' }).request('/workloads')
  ).text();
  const row = (id: string): string => textOf(body.match(new RegExp(`<tr[^>]*\\sdata-run="${id}"[\\s\\S]*?</tr>`))?.[0] ?? '');

  assert.match(row('over'), /success failed Exceeded: budget/);
  assert.match(row('cut'), /success failed Interrupted/);
});
