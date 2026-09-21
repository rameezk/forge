import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/index.ts';
import type { RunRecord } from '../src/index.ts';

const sampleRun = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  id: 'run-01',
  worker: 'refiner',
  harness: 'pi',
  model: 'anthropic/claude-opus-4',
  startTime: '2026-09-21T10:00:00.000Z',
  endTime: '2026-09-21T10:03:20.000Z',
  status: 'success',
  costUncertain: false,
  costUsd: 0.1234,
  inputTokens: 4200,
  outputTokens: 850,
  transcriptRef: 'run-01.jsonl',
  sessionId: 'sess-abc',
  error: null,
  ...overrides,
});

test('given a fresh store, when a run record with every field is inserted, then it round-trips', () => {
  const store = Store.open(':memory:');
  const run = sampleRun();

  store.insertRun(run);

  assert.deepEqual(store.getRun('run-01'), run);
});

test('given a run written at start, when it is inserted, then it round-trips with a null end time and no error', () => {
  const store = Store.open(':memory:');
  const run = sampleRun({
    id: 'run-running',
    status: 'running',
    endTime: null,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    transcriptRef: null,
    sessionId: null,
    error: null,
  });

  store.insertRun(run);

  assert.deepEqual(store.getRun('run-running'), run);
});

test('given a run with the cost-uncertain flag set, when it is inserted, then the flag round-trips as a boolean, not an integer', () => {
  const store = Store.open(':memory:');
  const run = sampleRun({ id: 'run-uncertain', costUncertain: true });

  store.insertRun(run);

  assert.equal(store.getRun('run-uncertain')?.costUncertain, true);
});

test('given a fresh store, when an unknown run is read, then it returns undefined', () => {
  const store = Store.open(':memory:');

  assert.equal(store.getRun('nope'), undefined);
});
