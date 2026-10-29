import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import type { RunRecord } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { textOf, tile } from './html.ts';

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

const ticketIn = (repository: string, number: number) => ({
  repository,
  number,
  url: `https://github.com/rameezk/${repository}/issues/${number}`,
});

const open = async (runs: RunRecord[], path = '/workloads'): Promise<string> => {
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

const workloadsTile = (body: string): string => textOf(tile(body, 'workloads'));

const costTile = (body: string): string => textOf(tile(body, 'cost'));

const mixed = [
  sampleRun({ id: 'forge-ok', ticket: ticketIn('forge', 1), costUsd: 0.1 }),
  sampleRun({ id: 'forge-err', status: 'error', ticket: ticketIn('forge', 2), costUsd: 0.2 }),
  sampleRun({ id: 'other-err', status: 'error', ticket: ticketIn('other', 3), costUsd: 0.4 }),
  sampleRun({ id: 'other-ok', ticket: ticketIn('other', 4), costUsd: 0.8 }),
];

test('given workloads across statuses and repositories, when opened with Failed and one repository, then only that repository\'s failed workloads list, the chips count within the repository and the header reads filtered of all', async () => {
  const body = await open(mixed, '/workloads?status=failed&repository=forge');

  assert.deepEqual(listed(body), ['forge-err']);
  assert.equal(chip(body, 'all'), 'All 2');
  assert.equal(chip(body, 'running'), 'Running 0');
  assert.equal(chip(body, 'done'), 'Done 1');
  assert.equal(chip(body, 'failed'), 'Failed 1');
  assert.equal(workloadsTile(body), 'Workloads 1 of 4');
  assert.equal(costTile(body), 'Cost $0.20');
  assert.doesNotMatch(body, /<tfoot/);
});

test('given workloads for several workers and tickets, when searched for a ticket number and then a worker name, then only that ticket\'s and then only that worker\'s list', async () => {
  const runs = [
    sampleRun({ id: 'a', worker: 'implementer', ticket: ticketIn('forge', 12) }),
    sampleRun({ id: 'b', worker: 'refiner', ticket: ticketIn('forge', 120) }),
    sampleRun({ id: 'c', worker: 'refiner', ticket: ticketIn('forge', 7) }),
  ];

  assert.deepEqual(listed(await open(runs, '/workloads?search=12')), ['a']);
  assert.deepEqual(listed(await open(runs, '/workloads?search=%2312')), ['a']);
  assert.deepEqual(listed(await open(runs, '/workloads?search=refin')).sort(), ['b', 'c']);
});

test('given workloads from several workers and models, when filtered by worker and by model, then each dropdown narrows the list and offers every value', async () => {
  const runs = [
    sampleRun({ id: 'a', worker: 'implementer', model: 'x/one' }),
    sampleRun({ id: 'b', worker: 'refiner', model: 'x/two' }),
  ];

  assert.deepEqual(listed(await open(runs, '/workloads?worker=refiner')), ['b']);
  const body = await open(runs, '/workloads?model=x%2Fone');
  assert.deepEqual(listed(body), ['a']);
  assert.match(body, /<option value="x\/two">/);
});

test('given workloads started today and two weeks ago, when filtered to the last 7 days, then only today\'s list', async () => {
  const day = (daysAgo: number): string => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  const runs = [sampleRun({ id: 'today', startTime: day(0) }), sampleRun({ id: 'old', startTime: day(14) })];

  assert.deepEqual(listed(await open(runs, `/workloads?from=${day(7).slice(0, 10)}`)), ['today']);
  assert.deepEqual(listed(await open(runs, `/workloads?to=${day(7).slice(0, 10)}`)), ['old']);
});

test('given billed and subscription workloads, when filtered to the subscription ones, then the Cost tile reads $0.00 with the list-price note', async () => {
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

  const body = await (await app.request('/workloads?model=x%2Fsub')).text();

  assert.equal(workloadsTile(body), 'Workloads 1 of 2');
  assert.equal(costTile(body), 'Cost $0.00 $0.03 list price, not billed');
  assert.doesNotMatch(await open([sampleRun()]), /list-price-equivalent/);
});

test('given a filtered view, when it lists nothing or "Clear filters" is followed, then the empty state shows and the link returns to every workload', async () => {
  const empty = await open(mixed, '/workloads?status=running');
  assert.deepEqual(listed(empty), []);
  assert.match(empty, /No workloads match/);
  assert.match(empty, /<a href="\/workloads"[^>]*data-clear-filters/);
  assert.doesNotMatch(await open(mixed), /data-clear-filters/);
  assert.equal(listed(await open(mixed, '/workloads')).length, 4);
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

const numbered = (count: number, overrides: (index: number) => Partial<RunRecord> = () => ({})): RunRecord[] =>
  Array.from({ length: count }, (_, index) =>
    sampleRun({
      id: `run-${String(index).padStart(3, '0')}`,
      startTime: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
      ...overrides(index),
    }),
  );

const pageLink = (body: string, direction: 'newer' | 'older'): { href: string | undefined; available: boolean } => {
  const element = body.match(new RegExp(`<(?:a|span)[^>]*\\sdata-page-link="${direction}"[^>]*>`))?.[0];
  assert.ok(element, `${direction} control missing`);
  return { href: element.match(/\shref="([^"]*)"/)?.[1]?.replaceAll('&amp;', '&'), available: element.startsWith('<a') };
};

test('given 120 workloads, when Workloads is opened, then the newest 50 list, Newer is unavailable and Older leads to the next 50', async () => {
  const runs = numbered(120);
  const body = await open(runs);

  assert.deepEqual(listed(body), runs.slice(70).reverse().map((run) => run.id));
  assert.equal(pageLink(body, 'newer').available, false);
  const older = pageLink(body, 'older');
  assert.equal(older.available, true);

  const next = await open(runs, older.href);
  assert.deepEqual(listed(next), runs.slice(20, 70).reverse().map((run) => run.id));
  assert.equal(pageLink(next, 'newer').available, true);
});

test('given 120 workloads, when the third page is opened, then the oldest 20 list and Older is unavailable', async () => {
  const runs = numbered(120);
  const body = await open(runs, '/workloads?page=3');

  assert.deepEqual(listed(body), runs.slice(0, 20).reverse().map((run) => run.id));
  assert.equal(pageLink(body, 'older').available, false);
  assert.equal(pageLink(body, 'newer').available, true);
});

test('given more than 50 failed workloads among others, when filtered to Failed and Older is followed, then the second page lists only failed workloads and Failed stays selected', async () => {
  const runs = numbered(130, (index) => ({ status: index % 2 === 0 ? 'error' : 'success' }));
  const first = await open(runs, '/workloads?status=failed');
  const older = pageLink(first, 'older');
  assert.equal(older.available, true);

  const second = await open(runs, older.href);
  const ids = listed(second);
  assert.equal(ids.length, 15);
  assert.ok(ids.every((id) => runs.find((run) => run.id === id)?.status === 'error'));
  assert.match(second, /data-status-chip="failed"[^>]*aria-current="true"/);
  assert.equal(pageLink(second, 'older').available, false);
  assert.match(pageLink(second, 'newer').href ?? '', /status=failed/);
});

test('given more than 50 matching workloads, when the second page is opened, then the counts and the header cover every matching workload', async () => {
  const runs = numbered(120, (index) => ({ costUsd: 1, status: index < 100 ? 'success' : 'error' }));
  const body = await open(runs, '/workloads?page=2');

  assert.equal(listed(body).length, 50);
  assert.equal(workloadsTile(body), 'Workloads 120');
  assert.equal(costTile(body), 'Cost $120.00');
  assert.match(chip(body, 'all'), /120/);
  assert.match(chip(body, 'failed'), /20/);
});

test('given a page beyond the last, when opened, then the last page lists', async () => {
  const runs = numbered(120);
  assert.equal(listed(await open(runs, '/workloads?page=9')).length, 20);
  assert.equal(listed(await open(runs, '/workloads?page=abc')).length, 50);
});

test('given a filtered, paged runs list, when its links are read, then the filter form, status chips and paging links stay under /workloads', async () => {
  const runs = numbered(130, (index) => ({ status: index % 2 === 0 ? 'error' : 'success' }));
  const body = await open(runs, '/workloads?status=failed');

  assert.match(body, /<form[^>]*\saction="\/workloads"/);
  const chipHrefs = [...body.matchAll(/<a[^>]*\sdata-status-chip="[^"]*"[^>]*>/g)].map(([tag]) => tag.match(/\shref="([^"]*)"/)?.[1]);
  assert.ok(chipHrefs.length > 0);
  assert.ok(chipHrefs.every((href) => href === '/workloads' || href?.startsWith('/workloads?')), chipHrefs.join(' '));
  assert.match(pageLink(body, 'older').href ?? '', /^\/workloads\?status=failed&page=2$/);
});

test('given a billed workload and an unconfirmed one with an estimate, when the list is requested, then the Cost tile and the unconfirmed row show the estimate apart from billed cost', async () => {
  const body = await open([
    sampleRun({ id: 'billed', costUsd: 0.2 }),
    sampleRun({ id: 'unconfirmed', costStatus: 'unconfirmed', costUsd: 0, unconfirmedEstimateUsd: 0.36 }),
  ]);

  assert.equal(costTile(body), 'Cost $0.20 + ~$0.36 unconfirmed');
  assert.match(tile(body, 'cost'), /<span[^>]*\sdata-unconfirmed-estimate-total[^>]*\stitle="[^"]*list price for generations billing gave up on[^"]*"/);
  assert.match(textOf(body.match(/<td[^>]*\sdata-cost(?=[\s>])[^>]*>[\s\S]*?<\/td>/g)?.find((cell) => /unconfirmed/.test(cell)) ?? ''), /\$0\.000000 billed \+ ~\$0\.360000 unconfirmed estimate/);
});

test('given a subscription workload carrying an unconfirmed estimate, when the list is requested, then the header total leaves it out like every other subscription cost', async () => {
  const body = await open([
    sampleRun({ id: 'billed', costUsd: 0.2 }),
    sampleRun({ id: 'sub', costStatus: 'subscription', costUsd: 0, unconfirmedEstimateUsd: 0.5 }),
  ]);

  assert.equal(workloadsTile(body), 'Workloads 2');
  assert.equal(costTile(body), 'Cost $0.20');
});
