import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GenerationRecord, HarnessEvent, TokenUsage } from '@forge/shared';
import { traceOf, type Step } from '../src/trace.ts';

const NO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

const generation = (id: string, overrides: Partial<GenerationRecord> = {}): GenerationRecord => ({
  runId: 'run-01',
  generationId: id,
  subagent: null,
  kind: 'message',
  usage: NO_USAGE,
  estimatedCostUsd: null,
  listPriceEquivalentUsd: null,
  billedCostUsd: null,
  reasoningTokens: null,
  provider: null,
  servedModel: null,
  attempts: 0,
  lastAttemptAt: null,
  lastError: null,
  givenUpAt: null,
  createdAt: '2026-09-21T10:00:01.000Z',
  ...overrides,
});

const message = (generationId: string, subagent?: string): HarnessEvent => ({
  type: 'message',
  role: 'assistant',
  text: '',
  usage: NO_USAGE,
  generationId,
  ...(subagent === undefined ? {} : { subagent }),
});

const toolCall = (id: string, name: string, subagent?: string): HarnessEvent => ({
  type: 'tool_call',
  id,
  name,
  arguments: {},
  ...(subagent === undefined ? {} : { subagent }),
});

const toolResult = (id: string, subagent?: string): HarnessEvent => ({
  type: 'tool_result',
  id,
  isError: false,
  text: '',
  ...(subagent === undefined ? {} : { subagent }),
});

const retry = (subagent?: string): HarnessEvent => ({
  type: 'retry',
  attempt: 1,
  maxAttempts: 3,
  delayMs: 1000,
  error: null,
  ...(subagent === undefined ? {} : { subagent }),
});

const BASE = Date.parse('2026-09-21T10:00:00.000Z');

const arriving = (event: HarnessEvent, seconds: number): HarnessEvent => ({
  ...event,
  at: new Date(BASE + seconds * 1000).toISOString(),
});

const userPrompt: HarnessEvent = {
  type: 'message',
  role: 'user',
  text: 'go',
  usage: NO_USAGE,
  generationId: null,
};

const seconds = ({ start, end }: Step): [number | null, number | null] => [
  start === null ? null : (start - BASE) / 1000,
  end === null ? null : (end - BASE) / 1000,
];

const shape = (steps: Step[]): unknown[] =>
  steps.map(({ kind, name, children }) => (children.length === 0 ? [kind, name] : [kind, name, shape(children)]));

const usage = (inputTokens: number, cacheReadTokens: number, cacheWriteTokens = 0): TokenUsage => ({
  inputTokens,
  outputTokens: 10,
  cacheReadTokens,
  cacheWriteTokens,
});

test('given a generation that asked for two tool runs followed by their results, when the trace is built, then both tool runs sit under that generation', () => {
  const trace = traceOf(
    [message('gen-1'), toolCall('t1', 'read'), toolCall('t2', 'bash'), toolResult('t1'), toolResult('t2'), message('gen-2')],
    [generation('gen-1'), generation('gen-2')],
    false,
  );

  assert.deepEqual(shape(trace.steps), [
    ['generation', '', [['tool', 'read'], ['tool', 'bash']]],
    ['generation', ''],
  ]);
});

test('given a generation that started a subagent with its own generations and tool runs, when the trace is built, then the subagent is a branch under that generation holding its own steps and costing their sum', () => {
  const trace = traceOf(
    [
      message('gen-1'),
      toolCall('call_a', 'subagent'),
      message('gen-2', 'call_a'),
      toolCall('t1', 'read', 'call_a'),
      toolResult('t1', 'call_a'),
      message('gen-3', 'call_a'),
      toolResult('call_a'),
    ],
    [
      generation('gen-1', { subagent: null, billedCostUsd: 0.5 }),
      generation('gen-2', { subagent: 'call_a', billedCostUsd: 0.25 }),
      generation('gen-3', { subagent: 'call_a', estimatedCostUsd: 0.125 }),
    ],
    false,
  );

  assert.deepEqual(shape(trace.steps), [
    ['generation', '', [['subagent', 'subagent', [['generation', '', [['tool', 'read']]], ['generation', '']]]]],
  ]);
  const branch = trace.steps[0]!.children[0]!;
  assert.equal(branch.usd, 0.375);
  assert.equal(trace.steps[0]!.usd, 0.5);
  assert.equal(trace.total, 0.875);
});

test('given billed, estimated, pending, list-price and unpriced generations, when the trace is built, then each step carries its cost and basis, and a subscription run reads list prices only', () => {
  const metered = traceOf(
    [message('gen-1'), message('gen-2'), message('gen-3')],
    [
      generation('gen-1', { billedCostUsd: 0.01, estimatedCostUsd: 0.5 }),
      generation('gen-2', { estimatedCostUsd: 0.02 }),
      generation('gen-3'),
    ],
    false,
  );
  const subscription = traceOf(
    [message('gen-1'), message('gen-2')],
    [generation('gen-1', { listPriceEquivalentUsd: 0.03, billedCostUsd: 9 }), generation('gen-2')],
    true,
  );

  assert.deepEqual(metered.steps.map(({ cost }) => cost), [
    { usd: 0.01, basis: 'billed' },
    { usd: 0.02, basis: 'estimated' },
    { usd: 0, basis: 'pending' },
  ]);
  assert.deepEqual(subscription.steps.map(({ cost }) => cost), [
    { usd: 0.03, basis: 'list-price' },
    { usd: 0, basis: 'subscription' },
  ]);
  assert.equal(metered.total, 0.03);
  assert.equal(subscription.total, 0.03);
});

test('given a generation whose cache read falls well below the previous prompt size, when the trace is built, then only that step is flagged and the trace counts one miss', () => {
  const trace = traceOf(
    [message('gen-1'), message('gen-2'), message('gen-3'), message('gen-4', 'call_a'), message('gen-5')],
    [
      generation('gen-1', { usage: usage(0, 0, 1000) }),
      generation('gen-2', { usage: usage(100, 1000, 100) }),
      generation('gen-3', { usage: usage(50, 1200, 50) }),
      generation('gen-4', { subagent: 'call_a', usage: usage(150, 0, 50) }),
      generation('gen-5', { usage: usage(0, 100, 1200) }),
    ],
    false,
  );

  const flagged = [...trace.steps, ...trace.steps.flatMap(({ children }) => children)].map(({ cacheMiss }) => cacheMiss);
  assert.equal(trace.misses, 1);
  assert.deepEqual(flagged.filter(Boolean).length, 1);
  assert.equal(trace.steps[3]!.cacheMiss, false);
});

test('given a compaction and a cache-warm generation among messages, when the trace is built, then they are steps of their own kind beside the messages', () => {
  const trace = traceOf(
    [
      message('gen-1'),
      { type: 'compaction', reason: null, tokensBefore: null, tokensAfter: null, summary: null, error: null, calls: [{ generationId: 'gen-2', usage: NO_USAGE }] },
      { type: 'cache_warm', generationId: 'gen-3', usage: NO_USAGE },
    ],
    [generation('gen-1'), generation('gen-2', { kind: 'compaction' }), generation('gen-3', { kind: 'cache_warm' })],
    false,
  );

  assert.deepEqual(trace.steps.map(({ kind }) => kind), ['generation', 'compaction', 'cache_warm']);
});

test('given a generation that was retried, when the trace is built, then it carries the retry marker and no extra step appears', () => {
  const trace = traceOf(
    [message('gen-1'), toolCall('t1', 'bash'), toolResult('t1'), retry(), retry(), message('gen-2')],
    [generation('gen-1'), generation('gen-2')],
    false,
  );

  assert.deepEqual(trace.steps.map(({ retries }) => retries), [0, 2]);
  assert.equal(trace.steps.length, 2);
});

test('given generations the transcript does not mention, when the trace is built, then they still appear and count towards the total', () => {
  const trace = traceOf(
    [],
    [generation('gen-1', { billedCostUsd: 0.1 }), generation('gen-2', { subagent: 'call_a', billedCostUsd: 0.2 })],
    false,
  );

  assert.equal(trace.steps.length, 2);
  assert.equal(trace.total, 0.30000000000000004);
});

test('given a transcript with no arrival times, when the trace is built, then it is untimed, and with them it is timed', () => {
  const untimed = traceOf([message('gen-1')], [generation('gen-1')], false);
  const timed = traceOf([arriving(message('gen-1'), 1)], [generation('gen-1')], false);

  assert.equal(untimed.timed, false);
  assert.equal(timed.timed, true);
});

test('given a retry no generation followed and a generation the transcript does not mention, when the trace is built, then the retry marks the last generation once', () => {
  const trace = traceOf([message('gen-1'), retry()], [generation('gen-1'), generation('gen-2')], false);

  assert.deepEqual(trace.steps.map(({ retries }) => retries), [1, 0]);
});

test('given a subagent whose own events precede the tool call that started it, when the trace is built, then it is a single branch', () => {
  const trace = traceOf(
    [message('gen-1', 'call_a'), toolCall('call_a', 'subagent')],
    [generation('gen-1', { subagent: 'call_a' })],
    false,
  );

  assert.deepEqual(shape(trace.steps), [['subagent', 'call_a', [['generation', '']]]]);
});

test('given stamped events for a generation that asked for two tool runs followed by their results, when the trace is built, then the generation spans the event before it to its own arrival and both tool runs start when it ended and end at their own results', () => {
  const trace = traceOf(
    [
      arriving(userPrompt, 0),
      arriving(message('gen-1'), 3),
      arriving(toolCall('t1', 'read'), 3),
      arriving(toolCall('t2', 'bash'), 3),
      arriving(toolResult('t1'), 5),
      arriving(toolResult('t2'), 8),
      arriving(message('gen-2'), 10),
    ],
    [generation('gen-1'), generation('gen-2')],
    false,
  );

  const [first, second] = trace.steps;
  assert.deepEqual(seconds(first as Step), [0, 3]);
  assert.deepEqual(first?.children.map(seconds), [[3, 5], [3, 8]]);
  assert.deepEqual(seconds(second as Step), [8, 10]);
  assert.deepEqual([trace.start, trace.end].map((time) => (time === null ? null : (time - BASE) / 1000)), [0, 10]);
});

test('given a subagent and a tool run still waiting on their results, when the trace is built, then both are open-ended and the branch starts when the generation that started it ended', () => {
  const trace = traceOf(
    [
      arriving(userPrompt, 0),
      arriving(message('gen-1'), 2),
      arriving(toolCall('call_a', 'subagent'), 2),
      arriving(message('gen-2', 'call_a'), 5),
      arriving(toolCall('t1', 'bash', 'call_a'), 5),
    ],
    [generation('gen-1'), generation('gen-2', { subagent: 'call_a' })],
    false,
  );

  const [parent] = trace.steps;
  const [branch] = parent?.children ?? [];
  assert.deepEqual(seconds(branch as Step), [2, null]);
  const [inner] = branch?.children ?? [];
  assert.deepEqual(seconds(inner as Step), [2, 5]);
  assert.deepEqual(inner?.children.map(seconds), [[5, null]]);
});

test('given stamped compaction and cache-warm events, when the trace is built, then each spans the event before it to its own arrival', () => {
  const trace = traceOf(
    [
      arriving(userPrompt, 0),
      arriving({ type: 'cache_warm', generationId: 'warm-1', usage: NO_USAGE }, 4),
      arriving(
        { type: 'compaction', reason: null, tokensBefore: null, tokensAfter: null, summary: null, error: null, calls: [{ generationId: 'compact-1', usage: NO_USAGE }] },
        9,
      ),
    ],
    [generation('warm-1', { kind: 'cache_warm' }), generation('compact-1', { kind: 'compaction' })],
    false,
  );

  assert.deepEqual(trace.steps.map(seconds), [[0, 4], [4, 9]]);
});

test('given a transcript with no arrival times, when the trace is built, then no step has a start or an end', () => {
  const trace = traceOf([message('gen-1'), toolCall('t1', 'read'), toolResult('t1')], [generation('gen-1')], false);

  assert.deepEqual(seconds(trace.steps[0] as Step), [null, null]);
  assert.deepEqual(trace.steps[0]?.children.map(seconds), [[null, null]]);
  assert.deepEqual([trace.start, trace.end], [null, null]);
});

test('given a subagent that made a very large number of tool runs, when the trace is built, then the branch starts at its earliest step', () => {
  const runs = Array.from({ length: 150_000 }, (_, index) => `t${index}`);
  const trace = traceOf(
    [
      arriving(userPrompt, 0),
      ...runs.map((id) => arriving(toolCall(id, 'bash', 'call_a'), 5)),
    ],
    [],
    false,
  );

  assert.equal(trace.steps.length, 1);
  assert.deepEqual(seconds(trace.steps[0] as Step), [5, null]);
});

const userMessage = (text: string, subagent?: string): HarnessEvent => ({
  type: 'message',
  role: 'user',
  text,
  usage: NO_USAGE,
  generationId: null,
  ...(subagent === undefined ? {} : { subagent }),
});

const reply = (generationId: string, text: string): HarnessEvent => ({ ...(message(generationId) as object), text }) as HarnessEvent;

test('given a tool run with arguments and a result, when the trace is built, then it carries its command, its output and the anchor of its tool call', () => {
  const trace = traceOf(
    [
      userMessage('go'),
      message('gen-1'),
      { type: 'tool_call', id: 't1', name: 'bash', arguments: { command: 'ls -la' } },
      { type: 'tool_result', id: 't1', isError: false, text: 'total 0' },
    ],
    [generation('gen-1')],
    false,
  );

  const tool = trace.steps[0]!.children[0]!;
  assert.equal(tool.request, 'ls -la');
  assert.equal(tool.response, 'total 0');
  assert.equal(tool.failed, false);
  assert.equal(tool.anchor, 2);
});

test('given a tool run whose result is an error or has not arrived, when the trace is built, then the failure is flagged and a missing output is null', () => {
  const trace = traceOf(
    [
      message('gen-1'),
      { type: 'tool_call', id: 't1', name: 'read', arguments: { path: 'a.txt' } },
      { type: 'tool_call', id: 't2', name: 'bash', arguments: {} },
      { type: 'tool_result', id: 't1', isError: true, text: 'no such file' },
    ],
    [generation('gen-1')],
    false,
  );

  const [failed, running] = trace.steps[0]!.children;
  assert.equal(failed!.failed, true);
  assert.equal(failed!.request, JSON.stringify({ path: 'a.txt' }, null, 2));
  assert.equal(running!.response, null);
  assert.equal(running!.request, null);
});

test('given a generation that follows a prompt and a tool result, when the trace is built, then its request is the input it answered and its response is its reply', () => {
  const trace = traceOf(
    [
      userMessage('fix the bug'),
      reply('gen-1', 'looking'),
      { type: 'tool_call', id: 't1', name: 'bash', arguments: { command: 'ls' } },
      { type: 'tool_result', id: 't1', isError: false, text: 'a.ts' },
      reply('gen-2', 'done'),
    ],
    [generation('gen-1'), generation('gen-2')],
    false,
  );

  const [first, second] = trace.steps;
  assert.equal(first!.request, 'fix the bug');
  assert.equal(first!.response, 'looking');
  assert.equal(second!.request, 'a.ts');
  assert.equal(second!.response, 'done');
  assert.equal(first!.anchor, 1);
});

test('given a long output, when the trace is built, then the excerpt is cut short', () => {
  const trace = traceOf(
    [message('gen-1'), { type: 'tool_call', id: 't1', name: 'bash', arguments: {} }, { type: 'tool_result', id: 't1', isError: false, text: 'x'.repeat(5000) }],
    [generation('gen-1')],
    false,
  );

  const output = trace.steps[0]!.children[0]!.response!;
  assert.ok(output.length < 700);
  assert.ok(output.endsWith('…'));
});

test('given a subagent branch, when the trace is built, then its anchor is the transcript position of the call that started it', () => {
  const trace = traceOf(
    [
      message('gen-1'),
      { type: 'tool_call', id: 'call_a', name: 'subagent', arguments: { task: 'review it' } },
      message('gen-2', 'call_a'),
      { type: 'tool_result', id: 'call_a', isError: false, text: 'looks fine' },
    ],
    [generation('gen-1'), generation('gen-2', { subagent: 'call_a' })],
    false,
  );

  const branch = trace.steps[0]!.children[0]!;
  assert.equal(branch.id, 'call_a');
  assert.equal(branch.request, 'review it');
  assert.equal(branch.response, 'looks fine');
  assert.equal(branch.anchor, 1);
});

const sinceBase = (seconds: number): number => BASE + seconds * 1000;

test('given a running workload whose latest generation has not arrived, when the trace is built at the current time, then a generation step opens where the last event arrived and the axis reaches the current time', () => {
  const trace = traceOf(
    [arriving(userPrompt, 0), arriving(message('gen-1'), 3), arriving(toolCall('t1', 'bash'), 3), arriving(toolResult('t1'), 5)],
    [generation('gen-1')],
    false,
    sinceBase(9),
  );

  const [first, waiting] = trace.steps;
  assert.equal(trace.steps.length, 2);
  assert.deepEqual(seconds(first as Step), [0, 3]);
  assert.equal(waiting?.kind, 'generation');
  assert.equal(waiting?.generation, null);
  assert.deepEqual(seconds(waiting as Step), [5, null]);
  assert.equal(trace.end, sinceBase(9));
  assert.equal(trace.calls, 1);
});

test('given the same transcript once its generation has arrived, when the trace is built at the current time, then the step is that generation and none is in progress', () => {
  const trace = traceOf(
    [arriving(userPrompt, 0), arriving(message('gen-1'), 3)],
    [generation('gen-1')],
    false,
    sinceBase(9),
  );

  assert.equal(trace.steps.length, 1);
  assert.deepEqual(seconds(trace.steps[0] as Step), [0, 3]);
  assert.equal(trace.end, sinceBase(9));
});

test('given a tool run still waiting on its result or a second one still running, when the trace is built at the current time, then no generation is in progress', () => {
  const waitingOnTool = traceOf(
    [arriving(userPrompt, 0), arriving(message('gen-1'), 2), arriving(toolCall('t1', 'bash'), 2)],
    [generation('gen-1')],
    false,
    sinceBase(9),
  );
  const parallel = traceOf(
    [arriving(userPrompt, 0), arriving(message('gen-1'), 2), arriving(toolCall('t1', 'read'), 2), arriving(toolCall('t2', 'bash'), 2), arriving(toolResult('t1'), 4)],
    [generation('gen-1')],
    false,
    sinceBase(9),
  );

  assert.equal(waitingOnTool.steps.length, 1);
  assert.equal(parallel.steps.length, 1);
  assert.deepEqual(parallel.steps[0]?.children.map(seconds), [[2, 4], [2, null]]);
});

test('given a subagent whose latest generation has not arrived, when the trace is built at the current time, then the step in progress sits in its branch', () => {
  const trace = traceOf(
    [
      arriving(userPrompt, 0),
      arriving(message('gen-1'), 2),
      arriving(toolCall('call_a', 'subagent'), 2),
      arriving({ ...userPrompt, subagent: 'call_a' }, 3),
    ],
    [generation('gen-1')],
    false,
    sinceBase(8),
  );

  const [branch] = trace.steps[0]?.children ?? [];
  assert.equal(trace.steps.length, 1);
  assert.deepEqual(branch?.children.map(seconds), [[3, null]]);
});

test('given no current time or a transcript with no arrival times, when the trace is built, then no step is in progress', () => {
  const settled = traceOf([arriving(userPrompt, 0), arriving(message('gen-1'), 3), arriving(toolResult('t1'), 4)], [generation('gen-1')], false);
  const untimed = traceOf([userPrompt, message('gen-1'), toolResult('t1')], [generation('gen-1')], false, sinceBase(9));

  assert.equal(settled.steps.length, 1);
  assert.equal(settled.end, sinceBase(4));
  assert.equal(untimed.steps.length, 1);
  assert.equal(untimed.timed, false);
  assert.equal(untimed.end, null);
});
