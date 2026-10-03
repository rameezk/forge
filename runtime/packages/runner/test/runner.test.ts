import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '@forge/shared';
import { runWorkload } from '../src/index.ts';
import {
  aWorker,
  arrayTranscripts,
  discardRawEvents,
  fakeHarness,
  fixedClock,
  message,
  result,
  throwingHarness,
  unlisted,
} from './helpers.ts';

const runWith = async (
  events: Parameters<typeof fakeHarness>[0],
  overrides: {
    worker?: Parameters<typeof aWorker>[0];
    hooks?: Parameters<typeof fakeHarness>[1];
  } = {},
) => {
  const store = Store.open(':memory:');
  const harness = fakeHarness(events, overrides.hooks);
  const transcripts = arrayTranscripts();
  const { id } = await runWorkload({
    store,
    harness,
    worker: aWorker(overrides.worker),
    openTranscript: transcripts.open,
    openRawEvents: discardRawEvents,
    openWorkspace: () => ({ workDir: '/work/run-1' }),
    now: fixedClock([
      '2026-09-21T10:00:00.000Z',
      '2026-09-21T10:00:05.000Z',
    ]),
    newId: () => 'run-1',
    lookUpListPrice: unlisted,
  });
  return { store, harness, transcripts, run: store.getRun(id) };
};

test('given a declared worker and a harness that ends normally, when it runs on demand, then a run is recorded and finalized as success with an end time and token counts', async () => {
  const store = Store.open(':memory:');
  const harness = fakeHarness([
    message({ usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
    result({ status: 'success', sessionId: 'sess-1' }),
  ]);

  const { id } = await runWorkload({
    store,
    harness,
    worker: aWorker(),
    openTranscript: arrayTranscripts().open,
    openRawEvents: discardRawEvents,
    openWorkspace: () => ({ workDir: '/work/run-1' }),
    now: fixedClock([
      '2026-09-21T10:00:00.000Z',
      '2026-09-21T10:00:05.000Z',
    ]),
    newId: () => 'run-1',
    lookUpListPrice: unlisted,
  });

  const run = store.getRun(id);
  assert.equal(id, 'run-1');
  assert.equal(run?.status, 'success');
  assert.equal(run?.worker, 'refiner');
  assert.equal(run?.harness, 'pi');
  assert.equal(run?.model, 'anthropic/claude-opus-4');
  assert.equal(run?.startTime, '2026-09-21T10:00:00.000Z');
  assert.equal(run?.endTime, '2026-09-21T10:00:05.000Z');
  assert.equal(run?.inputTokens, 100);
  assert.equal(run?.outputTokens, 40);
  assert.equal(run?.sessionId, 'sess-1');
  assert.equal(run?.error, null);
});

test('given a multi-message run, when it completes, then each assistant generation is recorded against the run with its subagent, the tokens are summed, and the cost stays pending for billing to settle', async () => {
  const { store, run } = await runWith([
    message({ usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, generationId: 'gen-a' }),
    message({
      usage: { inputTokens: 20, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
      generationId: 'gen-b',
      subagent: 'call_alpha',
    }),
    message({ role: 'user', usage: { inputTokens: 3, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, generationId: null }),
    result({ status: 'success' }),
  ]);

  assert.equal(run?.status, 'success');
  assert.equal(run?.inputTokens, 30);
  assert.equal(run?.outputTokens, 12);
  assert.equal(run?.costUsd, 0);
  assert.equal(run?.costStatus, 'pending');
  assert.deepEqual(
    store.listGenerations('run-1').map(({ generationId, subagent }) => ({ generationId, subagent })),
    [
      { generationId: 'gen-a', subagent: null },
      { generationId: 'gen-b', subagent: 'call_alpha' },
    ],
  );
});

test('given an assistant response with no generation id whose whole prompt was read from or written to the cache, when the run ends, then its tokens are recorded and counted in the run totals', async () => {
  const { store, run } = await runWith([
    message({ usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 900, cacheWriteTokens: 0 }, generationId: null }),
    message({ usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 300 }, generationId: null }),
    result({ status: 'success' }),
  ]);

  assert.equal(store.listGenerations('run-1').length, 2);
  assert.equal(run?.cacheReadTokens, 900);
  assert.equal(run?.cacheWriteTokens, 300);
  assert.equal(run?.costStatus, 'unconfirmed');
});

test('given a harness stream that ends in an error result, when it finishes, then the run is error with the error captured and an end time set', async () => {
  const { run } = await runWith([
    message(),
    result({ status: 'error', error: 'model refused', sessionId: 'sess-9' }),
  ]);

  assert.equal(run?.status, 'error');
  assert.equal(run?.error, 'model refused');
  assert.equal(run?.sessionId, 'sess-9');
  assert.equal(run?.endTime, '2026-09-21T10:00:05.000Z');
});

test('given a runner failure mid-stream, when it finishes, then the run is error with the thrown message and an end time, never left running, and the generation it saw is left pending for billing to settle', async () => {
  const store = Store.open(':memory:');
  const { id } = await runWorkload({
    store,
    harness: throwingHarness([message()], new Error('harness crashed')),
    worker: aWorker(),
    openTranscript: arrayTranscripts().open,
    openRawEvents: discardRawEvents,
    openWorkspace: () => ({ workDir: '/work/run-1' }),
    now: fixedClock(['2026-09-21T10:00:00.000Z', '2026-09-21T10:00:05.000Z']),
    newId: () => 'run-1',
    lookUpListPrice: unlisted,
  });

  const run = store.getRun(id);
  assert.equal(run?.status, 'error');
  assert.equal(run?.error, 'harness crashed');
  assert.equal(run?.endTime, '2026-09-21T10:00:05.000Z');
  assert.equal(run?.costStatus, 'pending');
  assert.deepEqual(
    store.listGenerations(id).map((generation) => generation.generationId),
    ['gen-1'],
  );
});

test('given a harness that throws with a secret in its message, when the run is recorded, then the stored error has the secret redacted', async () => {
  const store = Store.open(':memory:');
  const { id } = await runWorkload({
    store,
    harness: throwingHarness([], new Error('spawn failed for sk-or-secret')),
    worker: aWorker(),
    openTranscript: arrayTranscripts().open,
    openRawEvents: discardRawEvents,
    openWorkspace: () => ({ workDir: '/work/run-1' }),
    now: fixedClock(['2026-09-21T10:00:00.000Z', '2026-09-21T10:00:05.000Z']),
    newId: () => 'run-1',
    lookUpListPrice: unlisted,
    secrets: ['sk-or-secret'],
  });

  assert.equal(store.getRun(id)?.error, 'spawn failed for [redacted]');
});

test('given a harness stream that ends without a result event, when it finishes, then the run is error, not left running', async () => {
  const { run } = await runWith([message()]);

  assert.equal(run?.status, 'error');
  assert.equal(run?.endTime, '2026-09-21T10:00:05.000Z');
  assert.match(run?.error ?? '', /without a result/);
});

test('given a worker whose harness has begun but not finished, when the store is read mid-run, then a run exists with running status, a start time, no end time and a pending cost', async () => {
  const store = Store.open(':memory:');
  let midRun: ReturnType<Store['getRun']>;
  const harness = fakeHarness([message(), result({ status: 'success' })], {
    beforeEach: (index) => {
      if (index === 0) {
        midRun = store.getRun('run-1');
      }
    },
  });

  await runWorkload({
    store,
    harness,
    worker: aWorker(),
    openTranscript: arrayTranscripts().open,
    openRawEvents: discardRawEvents,
    openWorkspace: () => ({ workDir: '/work/run-1' }),
    now: fixedClock(['2026-09-21T10:00:00.000Z', '2026-09-21T10:00:05.000Z']),
    newId: () => 'run-1',
    lookUpListPrice: unlisted,
  });

  assert.equal(midRun?.status, 'running');
  assert.equal(midRun?.startTime, '2026-09-21T10:00:00.000Z');
  assert.equal(midRun?.endTime, null);
  assert.equal(midRun?.costStatus, 'pending');
  assert.equal(midRun?.transcriptRef, 'run-1.jsonl');
});

test('given a harness emitting a multi-event stream, when the worker runs, then the transcript accumulates events as they arrive and the run points at it', async () => {
  const store = Store.open(':memory:');
  const transcripts = arrayTranscripts();
  const events = [
    message({ text: 'first' }),
    message({ text: 'second' }),
    result({ status: 'success' }),
  ];
  const seenCounts: number[] = [];
  const harness = fakeHarness(events, {
    beforeEach: (index) => {
      if (index > 0) {
        seenCounts.push(transcripts.events('run-1').length);
      }
    },
  });

  const { id } = await runWorkload({
    store,
    harness,
    worker: aWorker(),
    openTranscript: transcripts.open,
    openRawEvents: discardRawEvents,
    openWorkspace: () => ({ workDir: '/work/run-1' }),
    now: fixedClock(['2026-09-21T10:00:00.000Z', '2026-09-21T10:00:05.000Z']),
    newId: () => 'run-1',
    lookUpListPrice: unlisted,
  });

  assert.deepEqual(seenCounts, [2, 3]);
  assert.deepEqual(transcripts.events('run-1').slice(1), events);
  assert.equal(transcripts.closed('run-1'), true);
  assert.equal(store.getRun(id)?.transcriptRef, 'run-1.jsonl');
});

test('given a worker declared with a reasoning effort, when it runs, then the harness is invoked with that effort', async () => {
  const { harness } = await runWith(
    [message(), result({ status: 'success' })],
    { worker: { reasoningEffort: 'high' } },
  );

  assert.equal(harness.invocations[0]?.reasoningEffort, 'high');
});

test('given a worker with no reasoning effort declared, when it runs, then the harness is invoked at the provider default with no effort set', async () => {
  const { harness } = await runWith([
    message(),
    result({ status: 'success' }),
  ]);

  assert.equal(harness.invocations[0]?.reasoningEffort, undefined);
  assert.equal('reasoningEffort' in (harness.invocations[0] ?? {}), false);
});

test('given a worker whose prompt contains a secret, when it is run, then the first transcript event is the prompt as a user message with the secret redacted', async () => {
  const store = Store.open(':memory:');
  const transcripts = arrayTranscripts();
  await runWorkload({
    store,
    harness: fakeHarness([message(), result({ status: 'success' })]),
    worker: aWorker({ prompt: '/work-on https://example.test/1 sk-or-secret' }),
    openTranscript: transcripts.open,
    openRawEvents: discardRawEvents,
    openWorkspace: () => ({ workDir: '/work/run-1' }),
    now: fixedClock(['2026-09-21T10:00:00.000Z', '2026-09-21T10:00:05.000Z']),
    newId: () => 'run-1',
    lookUpListPrice: unlisted,
    secrets: ['sk-or-secret'],
  });

  const [first, second] = transcripts.events('run-1');
  assert.deepEqual(first, {
    type: 'message',
    role: 'user',
    text: '/work-on https://example.test/1 [redacted]',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    generationId: null,
  });
  assert.equal(second?.type, 'message');
});
