import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, transcriptLine } from '@forge/shared';
import type { GenerationKind, HarnessEvent, LookupResult, RunRecord } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { textOf, tileValue } from './html.ts';

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
  unconfirmedEstimateUsd: 0,
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
  maxCostUsd: null,
  exceededLimit: null,
  counters: null,
  ...overrides,
});

interface Call {
  subagent?: string | null;
  kind?: GenerationKind;
  at?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  estimate?: number;
  listPrice?: number;
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
  effortField?: string;
}

const NO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const requestLine = (subagent: string | null, effort: string | null, field = 'reasoning'): string =>
  JSON.stringify({
    type: 'request',
    ...(subagent === null ? {} : { subagent }),
    body: { model: 'z-ai/glm-5', messages: [], ...(effort === null ? {} : { [field]: { effort } }) },
    cacheMarkers: [],
  });

interface Seeded {
  id: string;
  run?: Partial<RunRecord>;
  calls: Call[];
  recordRequests?: boolean;
  transcript?: object[];
}

const seed = (store: Store, dir: string, { id, run = {}, calls, recordRequests = true, transcript }: Seeded): void => {
  store.runs.insertRun(sampleRun({ id, ...(transcript === undefined ? {} : { transcriptRef: `${id}.jsonl` }), ...run }));
  if (transcript !== undefined) {
    writeFileSync(join(dir, `${id}.jsonl`), transcript.map((event) => `${JSON.stringify(event)}\n`).join(''));
  }
  calls.forEach((call, index) => {
    const usage = call.usage ?? NO_TOKENS;
    store.runs.recordGeneration({
      runId: id,
      generationId: `${id}-gen-${index + 1}`,
      subagent: call.subagent ?? null,
      kind: call.kind ?? 'message',
      usage: {
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
      },
      estimatedCostUsd: call.estimate ?? null,
      listPriceEquivalentUsd: call.listPrice ?? null,
      createdAt: call.at ?? `2026-09-21T10:00:${String(index + 1).padStart(2, '0')}.000Z`,
    });
  });
  const ids = new Map(store.runs.unsettledGenerations().map((g) => [g.generationId, g.id]));
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
  store.runs.recordLookups(lookups, '2026-09-21T10:30:00.000Z');
  if (recordRequests) {
    const lines = calls
      .filter((call) => call.sentEffort !== undefined)
      .map((call) => requestLine(call.subagent ?? null, call.sentEffort ?? null, call.effortField));
    writeFileSync(join(dir, `${id}.requests.jsonl`), lines.join('\n') + '\n');
  }
};

const dashboardOf = (runs: Seeded[], timeZone?: string, transcripts: Record<string, HarnessEvent[]> = {}, clock?: () => Date) => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-transcripts-'));
  const store = Store.open(':memory:');
  for (const run of runs) seed(store, dir, run);
  for (const [ref, events] of Object.entries(transcripts)) writeFileSync(join(dir, ref), events.map(transcriptLine).join(''));
  const app = createApp({ store, transcripts: new FileTranscriptSource(dir), css: '', logo: '', idiomorph: '', client: '', ...(timeZone === undefined ? {} : { timeZone }), ...(clock === undefined ? {} : { clock }) });
  return async (path: string): Promise<string> => (await app.request(path)).text();
};

const callsPage = async (
  run: Partial<RunRecord>,
  calls: Call[],
  options: { recordRequests?: boolean; transcript?: object[]; clock?: () => Date } = {},
): Promise<string> => {
  const { clock, ...seeded } = options;
  return dashboardOf([{ id: 'run-01', run, calls, ...seeded }], undefined, {}, clock)('/runs/run-01');
};

const cellOf = (row: string, name: string): string =>
  textOf(row.match(new RegExp(`<td[^>]*\\s${name}(?=[\\s>])[^>]*>([\\s\\S]*?)</td>`))?.[1] ?? 'missing');

const stepRows = (body: string): string[] =>
  body.match(/<(?:div|summary)[^>]*\sdata-step(?=[\s=>])[\s\S]*?<\/(?:div|summary)>/g) ?? [];

const costOfStep = (row: string): string =>
  textOf(row.match(/<span[^>]*\sdata-step-cost[^>]*>([\s\S]*?)<\/span>\s*<\/(?:div|summary)>/)?.[1] ?? 'missing');

test('given a finished workload with generations, when its page is requested, then a collapsed Trace section stands where Calls used to be and there is no Calls section', async () => {
  const body = await callsPage({}, [{ usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 } }]);

  assert.match(body, /<details(?![^>]*\sopen)[^>]*\sdata-trace-section/);
  assert.match(textOf(body.match(/<summary[^>]*\sdata-trace-summary[^>]*>([\s\S]*?)<\/summary>/)?.[1] ?? ''), /^Trace\b/);
  assert.doesNotMatch(body, /data-calls/);
  assert.doesNotMatch(body, />Calls</);
});

test('given a workload whose transcript has no arrival times, when its page is requested, then the trace offers Time disabled, Cost selected and the note Recorded before step timings', async () => {
  const body = await callsPage({}, [{}]);

  assert.match(body, /<button[^>]*\sdata-trace-view="time"[^>]*\sdisabled/);
  assert.match(body, /<button[^>]*\sdata-trace-view="cost"[^>]*\saria-pressed="true"/);
  assert.match(textOf(body.match(/<[^>]*\sdata-trace-note[^>]*>([\s\S]*?)<\/[a-z]+>/)?.[1] ?? 'missing'), /^Recorded before step timings$/);
});

const at = (seconds: number): string => new Date(Date.parse('2026-09-21T10:00:00.000Z') + seconds * 1000).toISOString();

const timedTranscript = (finished: boolean): object[] => {
  const turn = (generationId: string, seconds: number): object => ({
    type: 'message',
    role: 'assistant',
    text: '',
    usage: NO_TOKENS,
    generationId,
    at: at(seconds),
  });
  return [
    { type: 'message', role: 'user', text: 'go', usage: NO_TOKENS, generationId: null, at: at(0) },
    turn('run-01-gen-1', 3),
    { type: 'tool_call', id: 't1', name: 'read', arguments: {}, at: at(3) },
    { type: 'tool_call', id: 't2', name: 'bash', arguments: {}, at: at(3) },
    { type: 'tool_result', id: 't1', isError: false, text: '', at: at(5) },
    ...(finished ? [{ type: 'tool_result', id: 't2', isError: false, text: '', at: at(8) }, turn('run-01-gen-2', 10)] : []),
  ];
};

const timeBars = (body: string): string[] =>
  stepRows(body).map((row) => row.match(/data-step-time-bar[^>]*style="([^"]*)"/)?.[1] ?? 'missing');

const durationOf = (row: string): string =>
  textOf(row.match(/<span[^>]*\sdata-step-duration[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? 'missing');

test('given a workload whose transcript carries arrival times, when its page is requested, then Time is selected, no note is shown, each step shows how long it took and its bar sits on a waterfall over the run', async () => {
  const body = await callsPage({}, [{}, {}], { transcript: timedTranscript(true) });

  assert.match(body, /<button[^>]*\sdata-trace-view="time"[^>]*\saria-pressed="true"/);
  assert.doesNotMatch(body, /<button[^>]*\sdata-trace-view="time"[^>]*\sdisabled/);
  assert.match(body, /<button[^>]*\sdata-trace-view="cost"[^>]*\saria-pressed="false"/);
  assert.doesNotMatch(body, /data-trace-note/);
  assert.match(body, /<div[^>]*\sdata-trace[^>]*\sdata-bars="time"/);
  assert.deepEqual(stepRows(body).map(durationOf), ['3.0s', '2.0s', '5.0s', '2.0s']);
  assert.deepEqual(timeBars(body), ['left: 0%; width: 30%', 'left: 30%; width: 20%', 'left: 30%; width: 50%', 'left: 80%; width: 20%']);
});

const clockAt = (seconds: number) => (): Date => new Date(at(seconds));

test('given a running workload whose tool run has no result yet, when its page is requested, then that step is an open-ended bar running to the current time', async () => {
  const body = await callsPage({ status: 'running', endTime: null }, [{}], { transcript: timedTranscript(false), clock: clockAt(10) });

  const rows = stepRows(body);
  assert.deepEqual(rows.map((row) => /\sdata-step-open/.test(row)), [false, false, true]);
  assert.equal(durationOf(rows[2] as string), 'running');
  assert.deepEqual(timeBars(body), ['left: 0%; width: 30%', 'left: 30%; width: 20%', 'left: 30%; width: 70%']);
});

test('given a running workload whose latest generation has not arrived, when its page is requested, then the step in progress is an open-ended bar from the last event to the current time, marked as running', async () => {
  const transcript = timedTranscript(false).slice(0, 4);
  transcript.push({ type: 'tool_result', id: 't1', isError: false, text: '', at: at(5) }, { type: 'tool_result', id: 't2', isError: false, text: '', at: at(6) });
  const body = await callsPage({ status: 'running', endTime: null }, [{}], { transcript, clock: clockAt(10) });

  const rows = stepRows(body);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((row) => /\sdata-step-open/.test(row)), [false, false, false, true]);
  assert.equal(durationOf(rows[3] as string), 'running');
  assert.equal(timeBars(body)[3], 'left: 60%; width: 40%');
});

test('given a finished workload whose transcript ends on a tool result, when its page is requested, then no step is in progress', async () => {
  const transcript = [...timedTranscript(false).slice(0, 4), { type: 'tool_result', id: 't1', isError: false, text: '', at: at(5) }, { type: 'tool_result', id: 't2', isError: false, text: '', at: at(6) }];
  const body = await callsPage({}, [{}], { transcript, clock: clockAt(60) });

  assert.equal(stepRows(body).length, 3);
  assert.doesNotMatch(body, /data-step-open/);
});

test('given billed, estimated, unbilled and cache-missing generations, when its page is requested, then each step shows its kind, its cost and badge, and the cache miss is flagged', async () => {
  const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 1000 };
  const body = await callsPage({}, [
    { usage, billed: { cost: 0.0125 } },
    { usage: { ...usage, cacheRead: 1000, cacheWrite: 10 }, estimate: 0.002 },
    { usage: { ...usage, cacheRead: 0 } },
    { usage: { ...usage, cacheRead: 1000 }, kind: 'compaction', estimate: 0.001 },
  ]);

  const rows = stepRows(body);
  assert.deepEqual(rows.map(costOfStep), ['$0.012500 billed', '$0.002000 estimated', 'pending', '$0.001000 estimated']);
  assert.deepEqual(rows.map((row) => /\sdata-cache-miss/.test(row)), [false, false, true, false]);
  assert.deepEqual(rows.map((row) => row.match(/data-step-kind="([^"]+)"/)?.[1]), ['generation', 'generation', 'generation', 'compaction']);
});

test('given a subscription run with a priced and an unpriced generation, when its page is requested, then the trace shows the list price and the subscription badge', async () => {
  const body = await callsPage({ costStatus: 'subscription', costUsd: 0 }, [
    { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, listPrice: 0.01 },
    { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
  ]);

  assert.deepEqual(stepRows(body).map(costOfStep), ['$0.010000', 'subscription']);
  assert.doesNotMatch(body, /data-badge="(pending|billed|estimated)"/);
});

const summaryEffortOf = (body: string): string =>
  textOf(body.match(/<span[^>]*\sdata-summary-effort[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? 'missing');

const listEffort = (list: string, id: string): string =>
  cellOf(list.match(new RegExp(`<tr[^>]*\\sdata-run="${id}"[\\s\\S]*?</tr>`))?.[0] ?? '', 'data-effort');

const sent = (...efforts: (string | null)[]): Call[] =>
  efforts.map((sentEffort) => ({ sentEffort }));

test('given one workload whose calls all sent the configured effort and one whose calls sent different efforts, when the runs list and their detail pages are requested, then the list shows each configured effort, the first summary shows it, and the second shows varied', async () => {
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

  const list = await get('/workloads');
  const steady = await get('/runs/steady');
  const varied = await get('/runs/varied');

  assert.match(list, /<th[^>]*>Effort<\/th>/);
  assert.deepEqual([listEffort(list, 'steady'), listEffort(list, 'varied')], ['high', 'high']);
  assert.equal(summaryEffortOf(steady), 'high');
  assert.equal(summaryEffortOf(varied), 'varied');
});

test('given a workload with no configured effort whose calls sent none, one configured off whose calls sent none as pi does, and one with no request record, when their detail pages and the list are requested, then each shows its effort without varying', async () => {
  const get = dashboardOf([
    { id: 'unset', run: { startTime: '2026-09-21T12:00:00.000Z' }, calls: sent(null, null) },
    { id: 'off', run: { reasoningEffort: 'off', startTime: '2026-09-21T11:00:00.000Z' }, calls: sent('none') },
    { id: 'legacy', run: { reasoningEffort: 'medium', startTime: '2026-09-21T10:00:00.000Z' }, calls: [{}, {}], recordRequests: false },
  ]);

  const list = await get('/workloads');
  const unset = await get('/runs/unset');
  const off = await get('/runs/off');
  const legacy = await get('/runs/legacy');

  assert.deepEqual(['unset', 'off', 'legacy'].map((id) => listEffort(list, id)), ['default', 'off', 'medium']);
  assert.equal(summaryEffortOf(unset), 'default');
  assert.equal(summaryEffortOf(off), 'off');
  assert.equal(summaryEffortOf(legacy), 'medium');
});

test('given a request record of a hundred thousand requests, when its detail page is requested, then it renders promptly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-transcripts-'));
  const store = Store.open(':memory:');
  store.runs.insertRun(sampleRun());
  writeFileSync(join(dir, 'run-01.requests.jsonl'), (requestLine(null, 'high') + '\n').repeat(100_000));
  const app = createApp({ store, transcripts: new FileTranscriptSource(dir), css: '', logo: '', idiomorph: '', client: '' });

  const started = Date.now();
  const page = await app.request('/runs/run-01');

  assert.equal(page.status, 200);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started}ms`);
});

const NO_TOKENS_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

const assistant = (generationId: string, text: string): HarnessEvent => ({ type: 'message', role: 'assistant', text, usage: NO_TOKENS_USAGE, generationId });

const detailOf = (body: string, key: string): string =>
  body.match(new RegExp(`<section[^>]*\\sdata-step-detail="${key}"[\\s\\S]*?</section>`))?.[0] ?? 'missing';

const within = (detail: string, name: string): string =>
  textOf(detail.match(new RegExp(`<[a-z]+[^>]*\\s${name}(?=[\\s>])[^>]*>([\\s\\S]*?)</(?:dd|div|span|a|p|pre)>`))?.[1] ?? 'missing');

const traceEvents: HarnessEvent[] = [
  { type: 'message', role: 'user', text: 'fix the bug', usage: NO_TOKENS_USAGE, generationId: null },
  assistant('run-01-gen-1', 'looking at it'),
  { type: 'tool_call', id: 't1', name: 'bash', arguments: { command: 'ls -la' } },
  { type: 'tool_result', id: 't1', isError: false, text: 'total 0' },
];

test('given an open trace, when a tool run is selected, then its command, its output and a link to its tool call in the full transcript are in its details', async () => {
  const get = dashboardOf([{ id: 'run-01', run: { transcriptRef: 'run-01.jsonl' }, calls: [{}] }], undefined, { 'run-01.jsonl': traceEvents });

  const body = await get('/runs/run-01');
  const tool = body.match(/data-step-key="([^"]+)"[^>]*\sdata-step-kind="tool"|data-step-kind="tool"[^>]*\sdata-step-key="([^"]+)"/);
  const detail = detailOf(body, tool?.[1] ?? tool?.[2] ?? 'missing');

  assert.equal(within(detail, 'data-detail-request'), 'ls -la');
  assert.equal(within(detail, 'data-detail-response'), 'total 0');
  assert.match(detail, /<a[^>]*\shref="\/runs\/run-01\/transcript#event-2"[^>]*\sdata-detail-transcript/);
});

test('given an open trace, when a generation is selected, then its metadata, cost and badge, token breakdown, excerpts and transcript link are in its details, with a note for a cache miss', async () => {
  const usage = { input: 120, output: 450, cacheRead: 10, cacheWrite: 800 };
  const get = dashboardOf(
    [{ id: 'run-01', run: { transcriptRef: 'run-01.jsonl' }, calls: [{ usage: { input: 5, output: 5, cacheRead: 5000, cacheWrite: 0 } }, { usage, billed: { cost: 0.0125, provider: 'Google Vertex', model: 'anthropic/claude-opus-5.5' } }] }],
    undefined,
    { 'run-01.jsonl': [...traceEvents, assistant('run-01-gen-2', 'all done')] },
  );

  const body = await get('/runs/run-01');
  const generations = stepRows(body).filter((row) => row.includes('data-step-kind="generation"'));
  const detail = detailOf(body, generations[1]?.match(/data-step-key="([^"]+)"/)?.[1] ?? 'missing');

  assert.equal(within(detail, 'data-detail-generation'), 'run-01-gen-2');
  assert.equal(within(detail, 'data-detail-model'), 'anthropic/claude-opus-5.5');
  assert.equal(within(detail, 'data-detail-provider'), 'Google Vertex');
  assert.equal(within(detail, 'data-detail-cost'), '$0.012500 billed');
  assert.deepEqual(
    ['cache-read', 'cache-write', 'input', 'output'].map((name) => within(detail, `data-token="${name}"`)),
    ['10', '800', '120', '450'],
  );
  assert.match(detail, /data-detail-cache-miss/);
  assert.equal(within(detail, 'data-detail-request'), 'total 0');
  assert.equal(within(detail, 'data-detail-response'), 'all done');
  assert.match(detail, /<a[^>]*\shref="\/runs\/run-01\/transcript#event-4"[^>]*\sdata-detail-transcript/);
});
