import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, UNKNOWN_COHORT } from '@forge/shared';
import type { RunRecord } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { textOf, tile } from './html.ts';

const NOW = '2026-10-17T00:05:00.000Z';

const run = (id: string, startTime: string, overrides: Partial<RunRecord> = {}): RunRecord => ({
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
  unconfirmedEstimateUsd: 0,
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

const open = async (runs: RunRecord[], path: string, now = NOW): Promise<string> => {
  const store = Store.open(':memory:');
  for (const record of runs) store.runs.insertRun(record);
  const app = createApp({
    store,
    transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))),
    css: '',
    logo: '',
    idiomorph: '',
    client: '',
    clock: () => new Date(now),
  });
  return (await app.request(path)).text();
};

const listed = (body: string): string[] =>
  [...body.matchAll(/<tr[^>]*\sdata-run="([^"]+)"/g)].map((match) => match[1]!);

const preset = (body: string, key: string): string =>
  body.match(new RegExp(`<a[^>]*\\sdata-range-preset="${key}"[^>]*>`))?.[0] ?? 'missing';

const highlighted = (body: string): string[] =>
  [...body.matchAll(/<a[^>]*\sdata-range-preset="([^"]+)"[^>]*\saria-current="true"/g)].map((match) => match[1]!);

const input = (body: string, name: string): string =>
  body.match(new RegExp(`<input[^>]*\\sname="${name}"[^>]*>`))?.[0] ?? 'missing';

test('given workloads started yesterday and today and the clock at 00:05 UTC, when opened with the Today preset, then only today\'s list, Today is highlighted and the date inputs are empty', async () => {
  const runs = [run('yesterday', '2026-10-16T23:55:00.000Z'), run('today', '2026-10-17T00:01:00.000Z')];
  const body = await open(runs, '/workloads?range=today');

  assert.deepEqual(listed(body), ['today']);
  assert.deepEqual(highlighted(body), ['today']);
  assert.match(input(body, 'from'), /value=""/);
  assert.match(input(body, 'to'), /value=""/);
});

const ranges: { range: string; boundary: string; kept: string[]; dropped: string[] }[] = [
  { range: 'yesterday', boundary: 'yesterday', kept: ['2026-10-16T00:00:00.000Z', '2026-10-16T23:59:00.000Z'], dropped: ['2026-10-17T00:01:00.000Z', '2026-10-15T23:59:00.000Z'] },
  { range: '7d', boundary: 'last 7 days', kept: ['2026-10-17T00:01:00.000Z', '2026-10-11T00:00:00.000Z'], dropped: ['2026-10-10T23:59:00.000Z'] },
  { range: '30d', boundary: 'last 30 days', kept: ['2026-10-17T00:01:00.000Z', '2026-09-18T00:00:00.000Z'], dropped: ['2026-09-17T23:59:00.000Z'] },
  { range: 'month', boundary: 'this month', kept: ['2026-10-17T00:01:00.000Z', '2026-10-01T00:00:00.000Z'], dropped: ['2026-09-30T23:59:00.000Z'] },
];

for (const { range, boundary, kept, dropped } of ranges) {
  test(`given workloads either side of the ${boundary} boundary, when opened with range=${range}, then only the ones inside list and the preset is highlighted`, async () => {
    const runs = [...kept, ...dropped].map((startTime, index) => run(`run-${index}`, startTime));
    const body = await open(runs, `/workloads?range=${range}`);

    assert.deepEqual(listed(body).sort(), kept.map((startTime) => runs.find((record) => record.startTime === startTime)!.id).sort());
    assert.deepEqual(highlighted(body), [range]);
  });
}

const hrefOf = (tag: string): string => (tag.match(/\shref="([^"]*)"/)?.[1] ?? 'missing').replaceAll('&amp;', '&');

const spread = [run('today', '2026-10-17T00:01:00.000Z'), run('old', '2026-06-01T10:00:00.000Z')];

test('given workloads that started today and yesterday, when /workloads is opened bare, then only today lists, Today is highlighted, and neither Clear filters nor "of N" shows', async () => {
  const runs = [run('today', '2026-10-17T00:01:00.000Z'), run('yesterday', '2026-10-16T23:55:00.000Z')];
  const body = await open(runs, '/workloads');

  assert.deepEqual(listed(body), ['today']);
  assert.deepEqual(highlighted(body), ['today']);
  assert.doesNotMatch(body, /data-clear-filters/);
  assert.equal(textOf(tile(body, 'workloads')), 'Workloads 1');
});

test('given the bare page, when its links and form are read, then status chips and the form keep Today and Any time links to range=any', async () => {
  const body = await open(spread, '/workloads');
  const chips = [...body.matchAll(/<a[^>]*\sdata-status-chip="[^"]*"[^>]*>/g)].map(([tag]) => hrefOf(tag));

  assert.ok(chips.every((href) => href.includes('range=today')), chips.join(' '));
  assert.match(input(body, 'range'), /type="hidden"[^>]*value="today"/);
  assert.equal(hrefOf(preset(body, 'any')), '/workloads?range=any');
});

test('given workloads that started today and last month, when opened with range=any, then every workload lists, Any time is highlighted and Clear filters leads to the bare page', async () => {
  const body = await open(spread, '/workloads?range=any');

  assert.deepEqual(listed(body), ['today', 'old']);
  assert.deepEqual(highlighted(body), ['any']);
  assert.equal(hrefOf(body.match(/<a[^>]*\sdata-clear-filters[^>]*>/)?.[0] ?? 'missing'), '/workloads');
  assert.equal(textOf(tile(body, 'workloads')), 'Workloads 2 of 2');
});

test('given an invalid range, when opened, then it falls back to the bare page on Today', async () => {
  for (const path of ['/workloads?range=fortnight', '/workloads?range=']) {
    const body = await open(spread, path);

    assert.deepEqual(listed(body), ['today'], path);
    assert.deepEqual(highlighted(body), ['today'], path);
  }
});

test('given failed workloads in one cohort that started today and last month, when opened with the cohort and status but no range, then both list and no Started chip is highlighted', async () => {
  const failed = [run('today', '2026-10-17T00:01:00.000Z', { status: 'error' }), run('old', '2026-06-01T10:00:00.000Z', { status: 'error' })];
  const body = await open([...failed, run('fine', '2026-10-17T00:02:00.000Z')], `/workloads?cohort=${UNKNOWN_COHORT}&status=failed`);

  assert.deepEqual(listed(body), ['today', 'old']);
  assert.deepEqual(highlighted(body), []);
});

test('given a status filter and no range, when opened, then the Any time chip links to the same status with range=any', async () => {
  const body = await open(spread, '/workloads?status=done');

  assert.equal(hrefOf(preset(body, 'any')), '/workloads?status=done&range=any');
});

test('given range=7d with a worker, when opened, then the filter form carries the range as a hidden field', async () => {
  const body = await open(spread, '/workloads?range=7d&worker=refiner');

  assert.match(input(body, 'range'), /type="hidden"[^>]*value="7d"/);
});

test('given range=7d and explicit from and to dates, when opened, then the dates win, no preset is highlighted and the form still carries the range', async () => {
  const runs = [run('in', '2026-10-05T10:00:00.000Z'), run('recent', '2026-10-16T10:00:00.000Z'), run('old', '2026-06-01T10:00:00.000Z')];
  const body = await open(runs, '/workloads?range=7d&from=2026-10-01&to=2026-10-10');

  assert.deepEqual(listed(body), ['in']);
  assert.deepEqual(highlighted(body), []);
  assert.match(input(body, 'from'), /value="2026-10-01"/);
});

test('given explicit from and to dates, when opened, then no preset is highlighted and the inputs show the dates', async () => {
  const body = await open(spread, '/workloads?from=2026-10-01&to=2026-10-31');

  assert.deepEqual(listed(body), ['today']);
  assert.deepEqual(highlighted(body), []);
  assert.match(input(body, 'from'), /value="2026-10-01"/);
  assert.match(input(body, 'to'), /value="2026-10-31"/);
});

test('given explicit dates, a status and a worker, when opened, then every preset link keeps the status and worker and carries no dates', async () => {
  const body = await open(spread, '/workloads?from=2026-10-01&to=2026-10-31&status=done&worker=refiner');
  const hrefs = [...body.matchAll(/<a[^>]*\sdata-range-preset="([^"]+)"[^>]*>/g)].map(([tag, key]) => [key, hrefOf(tag)]);

  assert.deepEqual(hrefs, [
    ['any', '/workloads?status=done&worker=refiner&range=any'],
    ['today', '/workloads?status=done&worker=refiner&range=today'],
    ['yesterday', '/workloads?status=done&worker=refiner&range=yesterday'],
    ['7d', '/workloads?status=done&worker=refiner&range=7d'],
    ['30d', '/workloads?status=done&worker=refiner&range=30d'],
    ['month', '/workloads?status=done&worker=refiner&range=month'],
  ]);
});

test('given an active preset and more workloads than fit a page, when opened, then the status chip and pager links carry the range', async () => {
  const runs = Array.from({ length: 60 }, (_, index) => run(`run-${index}`, '2026-10-17T00:01:00.000Z'));
  const body = await open(runs, '/workloads?range=7d');
  const links = [...body.matchAll(/<a[^>]*\sdata-(?:status-chip|page-link)="[^"]*"[^>]*>/g)].map(([tag]) => hrefOf(tag));

  assert.ok(links.length > 1);
  assert.ok(links.every((href) => href.includes('range=7d')), links.join(' '));
});

test('given an active preset or explicit dates, when opened, then the Filters toggle names the preset or the range', async () => {
  const toggle = (body: string): string => textOf(body.match(/<summary[\s\S]*?<\/summary>/)?.[0] ?? 'missing');

  assert.equal(toggle(await open(spread, '/workloads?range=7d')), 'Filters Last 7 days');
  assert.equal(toggle(await open(spread, '/workloads?from=2026-10-01')), 'Filters from 2026-10-01');
  assert.equal(toggle(await open(spread, '/workloads')), 'Filters Today');
  assert.equal(toggle(await open(spread, '/workloads?range=any')), 'Filters Any time');
});

test('given a workload started just before midnight, when Today is opened either side of midnight UTC, then it lists only before midnight and Yesterday takes over after', async () => {
  const runs = [run('late', '2026-10-16T23:50:00.000Z')];

  assert.deepEqual(listed(await open(runs, '/workloads?range=today', '2026-10-16T23:59:00.000Z')), ['late']);
  assert.deepEqual(listed(await open(runs, '/workloads?range=today', '2026-10-17T00:01:00.000Z')), []);
  assert.deepEqual(listed(await open(runs, '/workloads?range=yesterday', '2026-10-17T00:01:00.000Z')), ['late']);
});
