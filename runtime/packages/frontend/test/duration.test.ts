import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import type { RunRecord } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { textOf } from './html.ts';

const sampleRun = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  id: 'run-01',
  worker: 'refiner',
  harness: 'pi',
  model: 'anthropic/claude-opus-4',
  reasoningEffort: null,
  startTime: '2026-09-21T10:00:00.000Z',
  endTime: '2026-09-21T10:03:20.000Z',
  status: 'success',
  costStatus: 'billed',
  costUsd: 0.1234,
  costEstimated: false,
  listPrice: null,
  inputTokens: 4200,
  outputTokens: 850,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  transcriptRef: null,
  sessionId: null,
  error: null,
  ticket: null,
  aliveAt: null,
  harnessStartTime: null,
  timeoutSeconds: null,
  maxCostUsd: null,
  exceededLimit: null,
  counters: null,
  ...overrides,
});

const appWith = (runs: RunRecord[]) => {
  const store = Store.open(':memory:');
  for (const run of runs) store.insertRun(run);
  return createApp({
    store,
    transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))),
    css: '',
    logo: '',
    idiomorph: '',
    client: '',
  });
};

const durationInRow = (body: string, id: string): string =>
  textOf(
    body
      .match(new RegExp(`<tr[^>]*\\sdata-run="${id}"[\\s\\S]*?</tr>`))?.[0]
      ?.match(/<td[^>]*\sdata-duration(?=[\s>])[^>]*>[\s\S]*?<\/td>/)?.[0] ?? '',
  );

const durationOnPage = (body: string): string =>
  textOf(body.match(/<dt[^>]*>Duration<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/)?.[1] ?? '');

const endingAfter = (seconds: number): Partial<RunRecord> => ({
  endTime: new Date(Date.parse('2026-09-21T10:00:00.000Z') + seconds * 1000).toISOString(),
});

test('given runs that took 59 seconds, 59 minutes 59 seconds, an hour and 2 hours 15 minutes 40 seconds, when the list and each run page are requested, then durations read in minutes until an hour and in hours after, dropping seconds', async () => {
  const cases: [string, number, string][] = [
    ['seconds', 59, '59s'],
    ['minutes', 59 * 60 + 59, '59m 59s'],
    ['hour', 3600, '1h 0m'],
    ['hours', 2 * 3600 + 15 * 60 + 40, '2h 15m'],
  ];
  const app = appWith(cases.map(([id, seconds]) => sampleRun({ id, ...endingAfter(seconds) })));

  const list = await (await app.request('/')).text();
  for (const [id, , expected] of cases) {
    assert.equal(durationInRow(list, id), expected, `list row ${id}`);
    assert.equal(durationOnPage(await (await app.request(`/runs/${id}`)).text()), expected, `run page ${id}`);
  }
});

test('given a running run and a finished one, when the list and run pages are requested, then only the running one carries its recorded start for the browser to count from, and the page does not depend on the time it is requested', async () => {
  const app = appWith([
    sampleRun({ id: 'running', status: 'running', endTime: null, costStatus: 'pending' }),
    sampleRun({ id: 'finished', ...endingAfter(200) }),
  ]);

  const list = await (await app.request('/')).text();
  const running = list.match(/<tr[^>]*\sdata-run="running"[\s\S]*?<\/tr>/)?.[0] ?? '';
  const finished = list.match(/<tr[^>]*\sdata-run="finished"[\s\S]*?<\/tr>/)?.[0] ?? '';
  assert.match(running, /<td[^>]*\sdata-duration[^>]*>\s*<span[^>]*\sdata-elapsed-since="2026-09-21T10:00:00.000Z"[^>]*>running<\/span>/);
  assert.doesNotMatch(finished, /data-elapsed-since/);
  assert.equal(durationInRow(list, 'finished'), '3m 20s');

  const page = await (await app.request('/runs/running')).text();
  assert.match(page, /<dd[^>]*\sdata-duration[^>]*>\s*<span[^>]*\sdata-elapsed-since="2026-09-21T10:00:00.000Z"[^>]*>running<\/span>/);
  assert.doesNotMatch(await (await app.request('/runs/finished')).text(), /data-elapsed-since/);
  assert.equal(await (await app.request('/runs/running')).text(), page);
});
