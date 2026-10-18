import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import type { RunRecord } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { textOf } from './html.ts';

const sampleRun = (id: string): RunRecord => ({
  id,
  worker: 'builder',
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

const PULL_REQUEST = 'https://github.com/rameezk/forge/pull/489';

const dashboard = () => {
  const store = Store.open(':memory:');
  store.insertRun(sampleRun('revision'));
  const start = store.startRevision({ repository: 'forge', number: 489, url: PULL_REQUEST }, [], 'revision', '2026-09-21T10:00:00.000Z', 10);
  assert.ok('started' in start);
  store.endRevision(start.started, 'ok', '2026-09-21T10:03:20.000Z');
  store.insertRun(sampleRun('first-build'));
  store.insertRun(sampleRun('resolution'));
  store.startConflictResolution({ repository: 'forge', number: 5, url: 'https://github.com/rameezk/forge/pull/5' }, [], 'resolution', new Date().toISOString(), 10, { headSha: 'head', defaultSha: 'default' });
  return createApp({ store, transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))), css: '', logo: '', idiomorph: '', client: '' });
};

const summaryOf = async (id: string): Promise<string> =>
  (await (await dashboard().request(`/runs/${id}`)).text()).match(/<p[^>]*\sdata-summary[\s>][\s\S]*?<\/p>/)?.[0] ?? 'missing';

test('given a revision run of PR #489, when its page is requested, then the summary shows a revision pill after the status pill followed by revises PR #489 linked to the pull request', async () => {
  const summary = await summaryOf('revision');

  assert.match(summary, /<span[^>]*\sdata-revision-pill>revision<\/span>/);
  assert.match(textOf(summary), /^success ok revision revises PR #489/);
  assert.match(summary, new RegExp(`<a[^>]*href="${PULL_REQUEST}"[^>]*>PR #489</a>`));
});

test('given a first build run, when its page is requested, then the summary shows no revision pill', async () => {
  const summary = await summaryOf('first-build');

  assert.doesNotMatch(summary, /data-revision-pill/);
  assert.doesNotMatch(textOf(summary), /revis/);
});

test('given a conflict resolution run, when its page is requested, then the summary shows no revision pill', async () => {
  assert.doesNotMatch(await summaryOf('resolution'), /data-revision-pill/);
});

test('given a revision run, a first build and a conflict resolution, when /workloads is requested, then only the revision carries the revision pill in its row and card', async () => {
  const body = await (await dashboard().request('/workloads')).text();
  const row = (id: string): string => body.match(new RegExp(`<tr[^>]*\\sdata-run="${id}"[\\s\\S]*?</tr>`))?.[0] ?? 'missing';
  const card = (id: string): string => body.match(new RegExp(`<article[^>]*\\sdata-run-card="${id}"[\\s\\S]*?</article>`))?.[0] ?? 'missing';

  assert.match(row('revision'), /data-revision-pill/);
  assert.match(card('revision'), /data-revision-pill/);
  for (const id of ['first-build', 'resolution']) {
    assert.doesNotMatch(row(id), /data-revision-pill/, id);
    assert.doesNotMatch(card(id), /data-revision-pill/, id);
  }
});
