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
  const revise = (runId: string, number: number, state: 'ok' | 'error', failure?: RevisionFailureRecord): void => {
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
  revise('unanswered', 1, 'error', { reason: 'unanswered', detail: DETAIL });
  revise('reasonless', 2, 'error');
  revise('good', 3, 'ok');
  return createApp({ store, transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))), css: '', logo: '', idiomorph: '', client: '' });
};

const EXPECTED: [string, string][] = [
  ['unanswered', 'success error Unanswered: https://github.com/rameezk/forge/pull/9#issuecomment-1 second line of the detail'],
  ['reasonless', 'success error no reason recorded'],
  ['good', 'success ok'],
];

test('given runs whose revisions ended with a reason, with no reason, and ok, when the list is requested, then each row shows success with its revision outcome beside it', async () => {
  const body = await (await dashboard().request('/runs')).text();

  for (const [id, expected] of EXPECTED) {
    const row = body.match(new RegExp(`<tr[^>]*\\sdata-run="${id}"[\\s\\S]*?</tr>`))?.[0] ?? '';
    const cell = row.match(/<td[^>]*>(?:(?!<\/td>)[\s\S])*data-status[\s\S]*?<\/td>/)?.[0] ?? 'missing';
    assert.equal(textOf(cell), expected, id);
    const card = body.match(new RegExp(`<article[^>]*\\sdata-run-card="${id}"[\\s\\S]*?</article>`))?.[0] ?? '';
    assert.ok(textOf(card).includes(expected), id);
  }
});

test('given the same runs, when each run page is requested, then the summary shows success with the revision outcome beside it and the Revises link carries the outcome', async () => {
  const app = dashboard();

  for (const [id, expected] of EXPECTED) {
    const body = await (await app.request(`/runs/${id}`)).text();
    const summary = body.match(/<p[^>]*\sdata-summary[\s>][\s\S]*?<\/p>/)?.[0] ?? 'missing';
    assert.ok(textOf(summary).startsWith(expected), id);
    const revises = body.match(/<dd[^>]*\sdata-revised-pull-request[\s>][\s\S]*?<\/dd>/)?.[0] ?? 'missing';
    assert.match(revises, /\sdata-outcome="(ok|error)"/, id);
  }
});
