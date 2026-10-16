import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import type { RunRecord } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { dashboard, SONNET, type Seed } from './insights-seed.ts';

const JOHANNESBURG = 'Africa/Johannesburg';
const LONDON = 'Europe/London';

const BEFORE_MIDNIGHT = '2026-10-14T21:30:00.000Z';
const AFTER_MIDNIGHT = '2026-10-14T22:30:00.000Z';

const sampleRun = (id: string, startTime: string): RunRecord => ({
  id,
  worker: 'refiner',
  harness: 'pi',
  model: 'anthropic/claude-opus-4',
  reasoningEffort: null,
  startTime,
  endTime: new Date(Date.parse(startTime) + 200_000).toISOString(),
  status: 'success',
  costStatus: 'billed',
  costUsd: 0.1,
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
});

const listed = async (timeZone: string | undefined, path: string): Promise<string[]> => {
  const store = Store.open(':memory:');
  store.insertRun(sampleRun('before', BEFORE_MIDNIGHT));
  store.insertRun(sampleRun('after', AFTER_MIDNIGHT));
  const app = createApp({
    store,
    transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))),
    css: '',
    logo: '',
    idiomorph: '',
    client: '',
    ...(timeZone === undefined ? {} : { timeZone }),
  });
  const body = await (await app.request(path)).text();
  return ['before', 'after'].filter((id) => body.includes(`href="/runs/${id}"`));
};

const seed = (id: string, start: string): Seed => ({ id, fingerprint: SONNET, start, seconds: 60, cost: 1, toolCalls: 1, retries: 0 });

const plotted = (page: string): string[] => [...page.matchAll(/data-run="([^"]+)"/g)].map(([, id]) => id!).sort();

const ticksOf = (page: string): { value: string; label: string }[] =>
  [...page.matchAll(/<g data-tick="time" data-value="([^"]+)">[\s\S]*?<text[^>]*>([^<]*)<\/text>/g)].map(([, value, label]) => ({
    value: value!,
    label: label!,
  }));

test('given runs at 21:30Z and 22:30Z and Africa/Johannesburg, when the workloads list is filtered to the 15th, then only the 22:30Z run is listed', async () => {
  assert.deepEqual(await listed(JOHANNESBURG, '/runs?from=2026-10-15&to=2026-10-15'), ['after']);
});

test('given runs at 21:30Z and 22:30Z and Africa/Johannesburg, when the workloads list is filtered to the 14th, then only the 21:30Z run is listed', async () => {
  assert.deepEqual(await listed(JOHANNESBURG, '/runs?from=2026-10-14&to=2026-10-14'), ['before']);
});

test('given runs at 21:30Z and 22:30Z and no display time zone, when the workloads list is filtered to the 14th, then both runs are listed', async () => {
  assert.deepEqual(await listed(undefined, '/runs?from=2026-10-14&to=2026-10-14'), ['before', 'after']);
});

test('given runs at 21:30Z and 22:30Z and Africa/Johannesburg, when the insights page is filtered to the 15th, then only the 22:30Z run counts', async () => {
  const { page } = dashboard([seed('before', BEFORE_MIDNIGHT), seed('after', AFTER_MIDNIGHT)], JOHANNESBURG);

  assert.deepEqual(plotted(await page('?from=2026-10-15&to=2026-10-15')), ['after']);
});

test('given runs at 21:30Z and 22:30Z and no display time zone, when the insights page is filtered to the 14th, then both runs count', async () => {
  const { page } = dashboard([seed('before', BEFORE_MIDNIGHT), seed('after', AFTER_MIDNIGHT)]);

  assert.deepEqual(plotted(await page('?from=2026-10-14&to=2026-10-14')), ['after', 'before']);
});

test('given costs either side of local midnight and Africa/Johannesburg, when the insights page is requested, then ticks and labels fall on local midnights', async () => {
  const { page } = dashboard(
    [seed('a', '2026-10-13T22:30:00.000Z'), seed('b', '2026-10-15T22:30:00.000Z'), seed('c', '2026-10-17T10:00:00.000Z')],
    JOHANNESBURG,
  );

  const ticks = ticksOf(await page());

  assert.ok(ticks.length >= 2);
  for (const { value } of ticks) assert.match(value, /T22:00:00\.000Z$/);
  assert.deepEqual(ticks.slice(0, 1), [{ value: '2026-10-13T22:00:00.000Z', label: 'Oct 14' }]);
});

test('given no display time zone, when the insights page is requested, then ticks fall on UTC midnights', async () => {
  const { page } = dashboard([seed('a', '2026-10-13T21:30:00.000Z'), seed('b', '2026-10-17T10:00:00.000Z')]);

  const ticks = ticksOf(await page());

  assert.deepEqual(ticks[0], { value: '2026-10-13T00:00:00.000Z', label: 'Oct 13' });
  for (const { value } of ticks) assert.match(value, /T00:00:00\.000Z$/);
});

test('given Europe/London and a range crossing the clocks going back, when the insights page is requested, then each local day has one tick and one label', async () => {
  const { page } = dashboard([seed('a', '2026-10-22T10:00:00.000Z'), seed('b', '2026-11-05T10:00:00.000Z')], LONDON);

  const ticks = ticksOf(await page());
  const labels = ticks.map(({ label }) => label);

  assert.equal(new Set(labels).size, labels.length);
  assert.ok(ticks.length >= 3);
  assert.deepEqual([...new Set(ticks.map(({ value }) => value.slice(11, 19)))].sort(), ['00:00:00', '23:00:00']);
});

test('given Europe/London and a range crossing the clocks going forward, when the insights page is requested, then no local day is skipped or repeated', async () => {
  const { page } = dashboard([seed('a', '2027-03-24T10:00:00.000Z'), seed('b', '2027-04-03T10:00:00.000Z')], LONDON);

  const ticks = ticksOf(await page());
  const labels = ticks.map(({ label }) => label);

  assert.equal(new Set(labels).size, labels.length);
  assert.ok(labels.length >= 3);
  assert.deepEqual([...new Set(ticks.map(({ value }) => value.slice(11, 19)))].sort(), ['00:00:00', '23:00:00']);
});
