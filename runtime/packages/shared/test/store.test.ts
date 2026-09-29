import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
  costStatus: 'billed',
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
    costStatus: 'pending',
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

test('given a fresh store, when an unknown run is read, then it returns undefined', () => {
  const store = Store.open(':memory:');

  assert.equal(store.getRun('nope'), undefined);
});

test('given a fresh store, when runs are listed, then an empty list is returned', () => {
  const store = Store.open(':memory:');

  assert.deepEqual(store.listRuns(), []);
});

test('given several runs, when they are listed, then they come back newest-first by start time', () => {
  const store = Store.open(':memory:');
  store.insertRun(sampleRun({ id: 'mid', startTime: '2026-09-21T10:00:00.000Z' }));
  store.insertRun(sampleRun({ id: 'newest', startTime: '2026-09-21T11:00:00.000Z' }));
  store.insertRun(sampleRun({ id: 'oldest', startTime: '2026-09-21T09:00:00.000Z' }));

  assert.deepEqual(
    store.listRuns().map((run) => run.id),
    ['newest', 'mid', 'oldest'],
  );
});

test('given a run recorded at start, when it is finalized, then result fields are written and identity and transcript are left intact', () => {
  const store = Store.open(':memory:');
  store.insertRun(
    sampleRun({
      id: 'run-final',
      status: 'running',
      endTime: null,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      transcriptRef: 'run-final.jsonl',
      sessionId: null,
      error: null,
    }),
  );

  store.finalizeRun('run-final', {
    endTime: '2026-09-21T10:03:20.000Z',
    status: 'success',
    costStatus: 'unconfirmed',
    costUsd: 0.42,
    inputTokens: 1000,
    outputTokens: 200,
    sessionId: 'sess-final',
    error: null,
  });

  assert.deepEqual(store.getRun('run-final'), {
    id: 'run-final',
    worker: 'refiner',
    harness: 'pi',
    model: 'anthropic/claude-opus-4',
    startTime: '2026-09-21T10:00:00.000Z',
    endTime: '2026-09-21T10:03:20.000Z',
    status: 'success',
    costStatus: 'unconfirmed',
    costUsd: 0.42,
    inputTokens: 1000,
    outputTokens: 200,
    transcriptRef: 'run-final.jsonl',
    sessionId: 'sess-final',
    error: null,
  });
});

test('given a store file in the old schema with one run whose cost was settled, one whose cost was uncertain, and one left running, when the store is opened, then the first is billed and the others unconfirmed with their recorded costs unchanged', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'forge-store-')), 'forge.db');
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE runs (
      id             TEXT PRIMARY KEY,
      worker         TEXT NOT NULL,
      harness        TEXT NOT NULL,
      model          TEXT NOT NULL,
      start_time     TEXT NOT NULL,
      end_time       TEXT,
      status         TEXT NOT NULL,
      cost_uncertain INTEGER NOT NULL,
      cost_usd       REAL NOT NULL,
      input_tokens   INTEGER NOT NULL,
      output_tokens  INTEGER NOT NULL,
      transcript_ref TEXT,
      session_id     TEXT,
      error          TEXT
    ) STRICT;
    INSERT INTO runs VALUES
      ('settled', 'refiner', 'pi', 'z-ai/glm-5', '2026-09-21T10:00:00.000Z', '2026-09-21T10:01:00.000Z', 'success', 0, 0.00093252, 1200, 40, 'settled.jsonl', 'sess-1', NULL),
      ('uncertain', 'refiner', 'pi', 'z-ai/glm-5', '2026-09-21T11:00:00.000Z', '2026-09-21T11:01:00.000Z', 'success', 1, 0.0125, 1300, 25, 'uncertain.jsonl', 'sess-2', NULL),
      ('abandoned', 'refiner', 'pi', 'z-ai/glm-5', '2026-09-21T12:00:00.000Z', NULL, 'running', 0, 0, 0, 0, 'abandoned.jsonl', NULL, NULL);
  `);
  old.close();

  const store = Store.open(path);

  assert.deepEqual(
    store.listRuns().map(({ id, costStatus, costUsd }) => ({ id, costStatus, costUsd })),
    [
      { id: 'abandoned', costStatus: 'unconfirmed', costUsd: 0 },
      { id: 'uncertain', costStatus: 'unconfirmed', costUsd: 0.0125 },
      { id: 'settled', costStatus: 'billed', costUsd: 0.00093252 },
    ],
  );
  store.close();
  assert.deepEqual(Store.open(path).listRuns().map((run) => run.costStatus), ['unconfirmed', 'unconfirmed', 'billed']);
});

test('given a current store file where another connection holds a write transaction, when the store is opened, then it opens without waiting on that writer', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'forge-store-')), 'forge.db');
  Store.open(path).close();
  const writer = new DatabaseSync(path);
  writer.exec('BEGIN IMMEDIATE');

  try {
    assert.deepEqual(Store.open(path).listRuns(), []);
  } finally {
    writer.exec('ROLLBACK');
    writer.close();
  }
});
