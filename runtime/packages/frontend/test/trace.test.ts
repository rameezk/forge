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
