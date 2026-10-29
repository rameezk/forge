import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import type { RunRecord } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { textOf } from './html.ts';

const sampleRun = (id: string, ticketNumber: number | null = null): RunRecord => ({
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
  ticket: ticketNumber === null ? null : { repository: 'forge', number: ticketNumber, url: `https://github.com/rameezk/forge/issues/${ticketNumber}` },
  aliveAt: null,
  harnessStartTime: null,
  timeoutSeconds: 7200,
  maxCostUsd: null,
  exceededLimit: null,
  counters: { toolCalls: 12, failedToolResults: 2, retries: 1, compactions: 0 },
});

const dashboard = () => {
  const store = Store.open(':memory:');
  store.insertRun(sampleRun('dispatched', 7));
  const dispatch = store.startDispatch({ repository: 'forge', number: 7, url: 'https://github.com/rameezk/forge/issues/7' }, 'dispatched', '2026-09-21T10:00:00.000Z', 10);
  assert.ok('started' in dispatch);
  store.insertRun(sampleRun('revised'));
  const revision = store.startRevision({ repository: 'forge', number: 489, url: 'https://github.com/rameezk/forge/pull/489' }, [], 'revised', '2026-09-21T10:00:00.000Z', 10);
  assert.ok('started' in revision);
  store.endRevision(revision.started, 'done', '2026-09-21T10:03:20.000Z');
  store.insertRun(sampleRun('resolved'));
  store.startConflictResolution({ repository: 'forge', number: 5, url: 'https://github.com/rameezk/forge/pull/5' }, [], 'resolved', new Date().toISOString(), 10, { headSha: 'head', defaultSha: 'default' });
  store.insertRun(sampleRun('manual'));
  return createApp({ store, transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))), css: '', logo: '', idiomorph: '', client: '' });
};

const body = async (): Promise<string> => (await dashboard().request('/workloads')).text();
const row = (page: string, id: string): string => page.match(new RegExp(`<tr[^>]*\\sdata-run="${id}"[\\s\\S]*?</tr>`))?.[0] ?? 'missing';
const card = (page: string, id: string): string => page.match(new RegExp(`<article[^>]*\\sdata-run-card="${id}"[\\s\\S]*?</article>`))?.[0] ?? 'missing';
const kindOf = (html: string): string | undefined => html.match(/<div[^>]*\sdata-workload-kind[^>]*>[\s\S]*?<\/div>/)?.[0];

const EXPECTED: [string, string, string][] = [
  ['dispatched', 'dispatch', 'forge #7'],
  ['revised', 'revision', 'forge PR #489'],
  ['resolved', 'conflict resolution', 'forge PR #5'],
];

test('given a dispatch, a revision and a conflict resolution, when /workloads is requested, then each row and card labels its kind under its ticket or pull request', async () => {
  const page = await body();

  for (const [id, kind, subject] of EXPECTED) {
    for (const html of [row(page, id), card(page, id)]) {
      const cell = html.match(/\sdata-run-ticket[^>]*>([\s\S]*?)(?=<\/td>|<span class="font-semibold">)/)?.[1] ?? 'missing';
      assert.equal(textOf(cell), `${subject} ${kind}`, id);
      assert.equal(textOf(kindOf(cell) ?? ''), kind, id);
    }
  }
});

test('given a run with no workload, when /workloads is requested, then its row and card carry no kind label', async () => {
  const page = await body();

  assert.doesNotMatch(row(page, 'manual'), /data-workload-kind/);
  assert.doesNotMatch(card(page, 'manual'), /data-workload-kind/);
});

test('given a revision, when /workloads is requested, then the card has no revision pill beside its start time and the row has none either', async () => {
  const page = await body();

  assert.doesNotMatch(card(page, 'revised'), /data-revision-pill/);
  assert.doesNotMatch(row(page, 'revised'), /data-revision-pill/);
});
