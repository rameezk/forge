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
  ...overrides,
});

const ticketIn = (repository: string, number: number) => ({
  repository,
  number,
  url: `https://github.com/rameezk/${repository}/issues/${number}`,
});

const open = async (runs: RunRecord[], path = '/'): Promise<string> => {
  const store = Store.open(':memory:');
  for (const run of runs) store.insertRun(run);
  const app = createApp({
    store,
    transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))),
    css: '',
    logo: '',
    idiomorph: '',
    client: '',
  });
  return (await app.request(path)).text();
};

const listed = (body: string): string[] =>
  [...body.matchAll(/<tr[^>]*\sdata-run="([^"]+)"/g)].map((match) => match[1]!);

const chip = (body: string, status: string): string =>
  textOf(body.match(new RegExp(`<a[^>]*\\sdata-status-chip="${status}"[^>]*>[\\s\\S]*?</a>`))?.[0] ?? 'missing');

const showing = (body: string): string =>
  textOf(body.match(/<p[^>]*\sdata-showing[\s>][\s\S]*?<\/p>/)?.[0] ?? 'missing');

const mixed = [
  sampleRun({ id: 'forge-ok', ticket: ticketIn('forge', 1), costUsd: 0.1 }),
  sampleRun({ id: 'forge-err', status: 'error', ticket: ticketIn('forge', 2), costUsd: 0.2 }),
  sampleRun({ id: 'other-err', status: 'error', ticket: ticketIn('other', 3), costUsd: 0.4 }),
  sampleRun({ id: 'other-ok', ticket: ticketIn('other', 4), costUsd: 0.8 }),
];

test('given workloads across statuses and repositories, when opened with Error and one repository, then only that repository\'s errored workloads list, the chips count within the repository and the header reads filtered of all', async () => {
  const body = await open(mixed, '/?status=error&repository=forge');

  assert.deepEqual(listed(body), ['forge-err']);
  assert.equal(chip(body, 'all'), 'All 2');
  assert.equal(chip(body, 'success'), 'Success 1');
  assert.equal(chip(body, 'error'), 'Error 1');
  assert.equal(chip(body, 'running'), 'Running 0');
  assert.equal(showing(body), 'Showing 1 of 4 workloads, $0.2000 of $1.5000 billed');
  assert.doesNotMatch(body, /<tfoot/);
});

test('given workloads for several workers and tickets, when searched for a ticket number and then a worker name, then only that ticket\'s and then only that worker\'s list', async () => {
  const runs = [
    sampleRun({ id: 'a', worker: 'implementer', ticket: ticketIn('forge', 12) }),
    sampleRun({ id: 'b', worker: 'refiner', ticket: ticketIn('forge', 120) }),
    sampleRun({ id: 'c', worker: 'refiner', ticket: ticketIn('forge', 7) }),
  ];

  assert.deepEqual(listed(await open(runs, '/?search=12')), ['a']);
  assert.deepEqual(listed(await open(runs, '/?search=%2312')), ['a']);
  assert.deepEqual(listed(await open(runs, '/?search=refin')).sort(), ['b', 'c']);
});

test('given workloads from several workers and models, when filtered by worker and by model, then each dropdown narrows the list and offers every value', async () => {
  const runs = [
    sampleRun({ id: 'a', worker: 'implementer', model: 'x/one' }),
    sampleRun({ id: 'b', worker: 'refiner', model: 'x/two' }),
  ];

  assert.deepEqual(listed(await open(runs, '/?worker=refiner')), ['b']);
  const body = await open(runs, '/?model=x%2Fone');
  assert.deepEqual(listed(body), ['a']);
  assert.match(body, /<option value="x\/two">/);
});

test('given workloads started today and two weeks ago, when filtered to the last 7 days, then only today\'s list', async () => {
  const day = (daysAgo: number): string => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  const runs = [sampleRun({ id: 'today', startTime: day(0) }), sampleRun({ id: 'old', startTime: day(14) })];

  assert.deepEqual(listed(await open(runs, `/?from=${day(7).slice(0, 10)}`)), ['today']);
  assert.deepEqual(listed(await open(runs, `/?to=${day(7).slice(0, 10)}`)), ['old']);
});

test('given billed and subscription workloads, when filtered to the subscription ones, then the header also shows the list-price equivalent in filtered of all shape', async () => {
  const store = Store.open(':memory:');
  store.insertRun(sampleRun({ id: 'billed', costUsd: 0.2 }));
  store.insertRun(sampleRun({ id: 'sub', costStatus: 'subscription', costUsd: 0, model: 'x/sub' }));
  store.recordGeneration({
    runId: 'sub',
    generationId: 'sub-gen',
    subagent: null,
    kind: 'message',
    usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    estimatedCostUsd: null,
    listPriceEquivalentUsd: 0.03,
    createdAt: '2026-09-21T10:00:01.000Z',
  });
  const app = createApp({ store, transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))), css: '', logo: '', idiomorph: '', client: '' });

  const body = await (await app.request('/?model=x%2Fsub')).text();

  assert.equal(
    showing(body),
    'Showing 1 of 2 workloads, $0.0000 of $0.2000 billed $0.0300 of $0.0300 list-price equivalent, not billed',
  );
  assert.doesNotMatch(await open([sampleRun()]), /list-price-equivalent/);
});

test('given a filtered view, when it lists nothing or "Clear filters" is followed, then the empty state shows and the link returns to every workload', async () => {
  const empty = await open(mixed, '/?status=running');
  assert.deepEqual(listed(empty), []);
  assert.match(empty, /No workloads match/);
  assert.match(empty, /<a href="\/"[^>]*data-clear-filters/);
  assert.doesNotMatch(await open(mixed), /data-clear-filters/);
  assert.equal(listed(await open(mixed, '/')).length, 4);
});

test('given a ticketed and a manual workload, when opened, then the columns follow the agreed order and the manual one shows a muted manual', async () => {
  const body = await open([sampleRun({ id: 'ticketed', ticket: ticketIn('forge', 5) }), sampleRun({ id: 'by-hand' })]);

  const headings = [...body.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((match) => match[1]);
  assert.deepEqual(headings, ['Started', 'Ticket', 'Status', 'Worker', 'Model', 'Effort', 'Duration', 'Cache hit', 'Cost']);
  const cell = (id: string): string =>
    body.match(new RegExp(`data-run="${id}"[\\s\\S]*?(<td[^>]*data-run-ticket[\\s\\S]*?</td>)`))?.[1] ?? '';
  assert.equal(textOf(cell('ticketed')), 'forge #5');
  assert.match(cell('by-hand'), /<span class="text-muted">manual<\/span>/);
});
