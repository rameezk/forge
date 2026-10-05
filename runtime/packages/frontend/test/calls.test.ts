import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import type { LookupResult, RunRecord } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { textOf } from './html.ts';

const sampleRun = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  id: 'run-01',
  worker: 'builder',
  harness: 'pi',
  model: 'z-ai/glm-5',
  reasoningEffort: null,
  startTime: '2026-09-21T10:00:00.000Z',
  endTime: '2026-09-21T10:03:20.000Z',
  status: 'success',
  costStatus: 'billed',
  costUsd: 0.1,
  costEstimated: false,
  listPrice: null,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  transcriptRef: null,
  sessionId: null,
  error: null,
  ticket: null,
  aliveAt: null,
  harnessStartTime: null,
  timeoutSeconds: null,
  exceededLimit: null,
  ...overrides,
});

interface Call {
  subagent?: string | null;
  at?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  estimate?: number;
  billed?: {
    cost: number;
    provider?: string;
    reasoningTokens?: number;
    model?: string;
    prompt?: number;
    cacheRead?: number;
    output?: number;
  };
  sentEffort?: string | null;
}

const NO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const requestLine = (subagent: string | null, effort: string | null): string =>
  JSON.stringify({
    type: 'request',
    ...(subagent === null ? {} : { subagent }),
    body: { model: 'z-ai/glm-5', messages: [], ...(effort === null ? {} : { reasoning: { effort } }) },
    cacheMarkers: [],
  });

interface Seeded {
  id: string;
  run?: Partial<RunRecord>;
  calls: Call[];
  recordRequests?: boolean;
}

const seed = (store: Store, dir: string, { id, run = {}, calls, recordRequests = true }: Seeded): void => {
  store.insertRun(sampleRun({ id, ...run }));
  calls.forEach((call, index) => {
    const usage = call.usage ?? NO_TOKENS;
    store.recordGeneration({
      runId: id,
      generationId: `${id}-gen-${index + 1}`,
      subagent: call.subagent ?? null,
      usage: {
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
      },
      estimatedCostUsd: call.estimate ?? null,
      createdAt: call.at ?? `2026-09-21T10:00:${String(index + 1).padStart(2, '0')}.000Z`,
    });
  });
  const ids = new Map(store.unsettledGenerations().map((g) => [g.generationId, g.id]));
  const lookups: LookupResult[] = [];
  calls.forEach((call, index) => {
    if (call.billed === undefined) return;
    lookups.push({
      id: ids.get(`${id}-gen-${index + 1}`)!,
      billing: {
        costUsd: call.billed.cost,
        usage:
          call.billed.prompt === undefined
            ? null
            : {
                promptTokens: call.billed.prompt,
                cacheReadTokens: call.billed.cacheRead ?? 0,
                outputTokens: call.billed.output ?? 0,
              },
        reasoningTokens: call.billed.reasoningTokens ?? null,
        provider: call.billed.provider ?? null,
        model: call.billed.model ?? null,
      },
    });
  });
  store.recordLookups(lookups, '2026-09-21T10:30:00.000Z');
  if (recordRequests) {
    const lines = calls
      .filter((call) => call.sentEffort !== undefined)
      .map((call) => requestLine(call.subagent ?? null, call.sentEffort ?? null));
    writeFileSync(join(dir, `${id}.requests.jsonl`), lines.join('\n') + '\n');
  }
};

const dashboardOf = (runs: Seeded[]) => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-transcripts-'));
  const store = Store.open(':memory:');
  for (const run of runs) seed(store, dir, run);
  const app = createApp({ store, transcripts: new FileTranscriptSource(dir), css: '', logo: '', idiomorph: '', client: '' });
  return async (path: string): Promise<string> => (await app.request(path)).text();
};

const callsPage = async (
  run: Partial<RunRecord>,
  calls: Call[],
  options: { recordRequests?: boolean } = {},
): Promise<string> => dashboardOf([{ id: 'run-01', run, calls, ...options }])('/runs/run-01');

const callRows = (body: string): string[] =>
  body.match(/<tr[^>]*\sdata-call(?=[\s=>])[\s\S]*?<\/tr>/g) ?? [];

const cellOf = (row: string, name: string): string =>
  textOf(row.match(new RegExp(`<td[^>]*\\s${name}(?=[\\s>])[^>]*>([\\s\\S]*?)</td>`))?.[1] ?? 'missing');

test('given a workload with one billed and one unbilled generation, when its detail page is requested, then the per-call table lists both, the billed row with its provider, reasoning tokens and billed cost, the unbilled row with blanks for both and its cost marked estimated', async () => {
  const body = await callsPage({}, [
    {
      usage: { input: 250, output: 45, cacheRead: 0, cacheWrite: 1000 },
      billed: { cost: 0.0125, provider: 'Z.AI', reasoningTokens: 12, prompt: 1250, cacheRead: 0, output: 45 },
    },
    { usage: { input: 100, output: 25, cacheRead: 1000, cacheWrite: 200 }, estimate: 0.002 },
  ]);

  const [billed, unbilled] = callRows(body) as [string, string];
  assert.equal(callRows(body).length, 2);
  assert.deepEqual(
    ['data-provider', 'data-reasoning', 'data-prompt', 'data-cache-read', 'data-cache-write', 'data-output', 'data-cost'].map((name) => cellOf(billed, name)),
    ['Z.AI', '12', '1,250', '0', '1,000', '45', '$0.012500 billed'],
  );
  assert.deepEqual(
    ['data-provider', 'data-reasoning', 'data-prompt', 'data-cache-read', 'data-cache-write', 'data-output', 'data-cost'].map((name) => cellOf(unbilled, name)),
    ['', '', '1,300', '1,000', '200', '25', '$0.002000 estimated'],
  );
  assert.match(cellOf(billed, 'data-time'), /^10:00:01 UTC$/);
});

const isHighlighted = (row: string): boolean => /<tr[^>]*\sdata-cache-miss(?=[\s>])/.test(row);

test('given a workload whose calls read the cache steadily, then one whose cache read falls well below the previous call\'s prompt size, when its detail page is requested, then the per-call table lists every call and highlights only that one', async () => {
  const body = await callsPage({}, [
    { usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 1000 } },
    { usage: { input: 100, output: 10, cacheRead: 1000, cacheWrite: 100 } },
    { usage: { input: 50, output: 10, cacheRead: 1200, cacheWrite: 50 } },
    { subagent: 'call_a', usage: { input: 150, output: 10, cacheRead: 0, cacheWrite: 50 } },
    { usage: { input: 0, output: 10, cacheRead: 100, cacheWrite: 1200 } },
    { usage: { input: 20, output: 10, cacheRead: 1300, cacheWrite: 0 } },
  ]);

  const rows = callRows(body);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map(isHighlighted), [false, false, false, false, true, false]);
  assert.match(rows[4] ?? '', /data-badge="cache-miss"/);
});

const summaryOf = (body: string, term: string): string =>
  textOf(body.match(new RegExp(`<dt[^>]*>${term}</dt>\\s*<dd[^>]*>([\\s\\S]*?)</dd>`))?.[1] ?? 'missing');

const listEffort = (list: string, id: string): string =>
  cellOf(list.match(new RegExp(`<tr[^>]*\\sdata-run="${id}"[\\s\\S]*?</tr>`))?.[0] ?? '', 'data-effort');

const sent = (...efforts: (string | null)[]): Call[] =>
  efforts.map((sentEffort) => ({ sentEffort }));

test('given one workload whose calls all sent the configured effort and one whose calls sent different efforts, when the runs list and their detail pages are requested, then the list shows each configured effort, the first summary shows it, the second shows varied, and each row shows the effort it sent', async () => {
  const get = dashboardOf([
    {
      id: 'steady',
      run: { reasoningEffort: 'high', startTime: '2026-09-21T11:00:00.000Z' },
      calls: [{ sentEffort: 'high' }, { sentEffort: 'high', subagent: 'call_a' }, { sentEffort: 'high' }],
    },
    {
      id: 'varied',
      run: { reasoningEffort: 'high', startTime: '2026-09-21T10:00:00.000Z' },
      calls: [{ sentEffort: 'high' }, { sentEffort: 'low' }, { sentEffort: 'minimal', subagent: 'call_a' }, { sentEffort: 'high', subagent: 'call_a' }],
    },
  ]);

  const list = await get('/');
  const steady = await get('/runs/steady');
  const varied = await get('/runs/varied');

  assert.match(list, /<th[^>]*>Effort<\/th>/);
  assert.deepEqual([listEffort(list, 'steady'), listEffort(list, 'varied')], ['high', 'high']);
  assert.equal(summaryOf(steady, 'Reasoning effort'), 'high');
  assert.equal(summaryOf(varied, 'Reasoning effort'), 'varied');
  assert.deepEqual(callRows(steady).map((row) => cellOf(row, 'data-effort')), ['high', 'high', 'high']);
  assert.deepEqual(callRows(varied).map((row) => cellOf(row, 'data-effort')), ['high', 'low', 'minimal', 'high']);
});

test('given a workload with no configured effort whose calls sent none, one configured off whose calls sent none as pi does, and one with no request record, when their detail pages and the list are requested, then the first two show their effort without varying and the last shows the configured effort with blank rows', async () => {
  const get = dashboardOf([
    { id: 'unset', run: { startTime: '2026-09-21T12:00:00.000Z' }, calls: sent(null, null) },
    { id: 'off', run: { reasoningEffort: 'off', startTime: '2026-09-21T11:00:00.000Z' }, calls: sent('none') },
    { id: 'legacy', run: { reasoningEffort: 'medium', startTime: '2026-09-21T10:00:00.000Z' }, calls: [{}, {}], recordRequests: false },
  ]);

  const list = await get('/');
  const unset = await get('/runs/unset');
  const off = await get('/runs/off');
  const legacy = await get('/runs/legacy');

  assert.deepEqual(['unset', 'off', 'legacy'].map((id) => listEffort(list, id)), ['default', 'off', 'medium']);
  assert.equal(summaryOf(unset, 'Reasoning effort'), 'default');
  assert.deepEqual(callRows(unset).map((row) => cellOf(row, 'data-effort')), ['default', 'default']);
  assert.equal(summaryOf(off, 'Reasoning effort'), 'off');
  assert.deepEqual(callRows(off).map((row) => cellOf(row, 'data-effort')), ['off']);
  assert.equal(summaryOf(legacy, 'Reasoning effort'), 'medium');
  assert.deepEqual(callRows(legacy).map((row) => cellOf(row, 'data-effort')), ['', '']);
});

test('given a generation OpenRouter billed as served by a model other than the worker\'s and an unbilled generation, when the detail page is requested, then the billed row shows the serving model beside its provider and the unbilled row shows it blank', async () => {
  const body = await callsPage({ model: 'z-ai/glm-5' }, [
    { billed: { cost: 0.01, provider: 'Novita', model: 'z-ai/glm-5.1' } },
    {},
  ]);

  const [billed, unbilled] = callRows(body) as [string, string];
  assert.deepEqual(
    ['data-provider', 'data-served-model'].map((name) => cellOf(billed, name)),
    ['Novita', 'z-ai/glm-5.1'],
  );
  assert.equal(cellOf(unbilled, 'data-served-model'), '');
  assert.ok(body.indexOf('data-provider') < body.indexOf('data-served-model'));
});

test('given a workload that sent an effort that is not a known level, when its detail page is requested, then the row shows it as unknown instead of the raw value', async () => {
  const body = await callsPage({}, sent('x'.repeat(5000)));

  assert.deepEqual(callRows(body).map((row) => cellOf(row, 'data-effort')), ['unknown']);
  assert.ok(body.length < 100_000);
});

test('given a workload with more generations than recorded requests, when its detail page is requested, then the rows beyond the recorded requests show no effort', async () => {
  const body = await callsPage({ reasoningEffort: 'high' }, [{ sentEffort: 'high' }, {}, {}]);

  assert.deepEqual(callRows(body).map((row) => cellOf(row, 'data-effort')), ['high', '', '']);
  assert.equal(summaryOf(body, 'Reasoning effort'), 'high');
});

test('given a request record of a hundred thousand requests, when its detail page is requested, then it renders promptly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-transcripts-'));
  const store = Store.open(':memory:');
  store.insertRun(sampleRun());
  writeFileSync(join(dir, 'run-01.requests.jsonl'), (requestLine(null, 'high') + '\n').repeat(100_000));
  const app = createApp({ store, transcripts: new FileTranscriptSource(dir), css: '', logo: '', idiomorph: '', client: '' });

  const started = Date.now();
  const page = await app.request('/runs/run-01');

  assert.equal(page.status, 200);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started}ms`);
});
