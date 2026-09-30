import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
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
  ticket: null,
  ...overrides,
});

test('given a fresh store, when a run record with every field is inserted, including the ticket it was dispatched for, then it round-trips', () => {
  const store = Store.open(':memory:');
  const run = sampleRun({
    ticket: {
      repository: 'forge',
      number: 113,
      url: 'https://github.com/rameezk/forge/issues/113',
    },
  });

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

test('given a run recorded at start, when it is finalized, then result fields are written, identity and transcript are left intact, and with no generations its cost is billed at nothing', () => {
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
    costStatus: 'billed',
    costUsd: 0,
    inputTokens: 1000,
    outputTokens: 200,
    transcriptRef: 'run-final.jsonl',
    sessionId: 'sess-final',
    error: null,
    ticket: null,
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
  const reopened = Store.open(path);
  assert.deepEqual(reopened.listRuns().map((run) => run.costStatus), ['unconfirmed', 'unconfirmed', 'billed']);
  reopened.close();
});

test('given a store file whose runs predate dispatch, when the store is opened, then its runs read back with no ticket and a dispatched run can be recorded', () => {
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
      cost_status    TEXT NOT NULL,
      cost_usd       REAL NOT NULL,
      input_tokens   INTEGER NOT NULL,
      output_tokens  INTEGER NOT NULL,
      transcript_ref TEXT,
      session_id     TEXT,
      error          TEXT
    ) STRICT;
    INSERT INTO runs VALUES
      ('by-hand', 'refiner', 'pi', 'z-ai/glm-5', '2026-09-21T10:00:00.000Z', '2026-09-21T10:01:00.000Z', 'success', 'billed', 0.5, 1200, 40, 'by-hand.jsonl', 'sess-1', NULL);
  `);
  old.close();
  const dispatched = sampleRun({
    id: 'dispatched',
    startTime: '2026-09-21T11:00:00.000Z',
    ticket: {
      repository: 'forge',
      number: 113,
      url: 'https://github.com/rameezk/forge/issues/113',
    },
  });

  const store = Store.open(path);
  store.insertRun(dispatched);

  assert.equal(store.getRun('by-hand')?.ticket, null);
  assert.deepEqual(store.getRun('dispatched'), dispatched);
  store.close();
  Store.open(path).close();
});

test('given a current store file where another connection holds a write transaction, when the store is opened, then it opens without waiting on that writer', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'forge-store-')), 'forge.db');
  Store.open(path).close();
  const writer = new DatabaseSync(path);
  writer.exec('BEGIN IMMEDIATE');

  try {
    const store = Store.open(path);
    assert.deepEqual(store.listRuns(), []);
    store.close();
  } finally {
    writer.exec('ROLLBACK');
    writer.close();
  }
});

const HOLD_WRITE_LOCK = `
  const { DatabaseSync } = require('node:sqlite');
  const { parentPort, workerData } = require('node:worker_threads');
  const writer = new DatabaseSync(workerData.path);
  writer.exec('BEGIN IMMEDIATE');
  parentPort.postMessage('locked');
  const released = new Int32Array(workerData.released);
  Atomics.wait(released, 0, 0, workerData.holdMs);
  Atomics.store(released, 0, 1);
  writer.exec('ROLLBACK');
  writer.close();
`;

test('given a store file from before the frontier where another connection briefly holds a write transaction, when the store is opened, then it waits for the writer and adds the frontier tables', async () => {
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
      cost_status    TEXT NOT NULL,
      cost_usd       REAL NOT NULL,
      input_tokens   INTEGER NOT NULL,
      output_tokens  INTEGER NOT NULL,
      transcript_ref TEXT,
      session_id     TEXT,
      error          TEXT
    ) STRICT;
  `);
  old.close();
  const released = new SharedArrayBuffer(4);
  const writer = new Worker(HOLD_WRITE_LOCK, { eval: true, workerData: { path, holdMs: 300, released } });
  await once(writer, 'message');

  try {
    const store = Store.open(path);
    assert.equal(Atomics.load(new Int32Array(released), 0), 1, 'the store should open only once the writer lets go');
    assert.deepEqual(store.listFrontier(), []);
    store.close();
  } finally {
    await once(writer, 'exit');
  }
});

test('given a store file whose frontier predates last errors, when the store is opened, then the stale snapshot is dropped and a repository that has never been polled can record when and why it failed', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'forge-store-')), 'forge.db');
  Store.open(path).close();
  const old = new DatabaseSync(path);
  old.exec(`
    DROP TABLE frontier_tickets;
    DROP TABLE frontier_repositories;
    CREATE TABLE frontier_repositories (
      repository TEXT PRIMARY KEY,
      github     TEXT NOT NULL,
      polled_at  TEXT NOT NULL
    ) STRICT;
    CREATE TABLE frontier_tickets (
      repository    TEXT NOT NULL REFERENCES frontier_repositories (repository) ON DELETE CASCADE,
      number        INTEGER NOT NULL,
      title         TEXT NOT NULL,
      url           TEXT NOT NULL,
      parent_number INTEGER,
      parent_title  TEXT,
      created_at    TEXT NOT NULL,
      PRIMARY KEY (repository, number)
    ) STRICT;
    INSERT INTO frontier_repositories VALUES ('forge', 'rameezk/forge', '2026-09-29T08:00:00.000Z');
  `);
  old.close();

  const store = Store.open(path);
  try {
    const failedAt = '2026-09-29T08:20:00.000Z';
    store.recordFrontierError({ repository: 'fresh', github: 'rameezk/fresh', message: 'GitHub token missing', failedAt });
    assert.deepEqual(store.listFrontier(), [
      { repository: 'fresh', github: 'rameezk/fresh', polledAt: null, lastError: { message: 'GitHub token missing', failedAt }, tickets: [] },
    ]);
  } finally {
    store.close();
  }
});

test('given a store file where another process briefly holds a write transaction, when this process writes a run, then the write waits for the other writer and succeeds instead of failing as busy', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'forge-store-')), 'forge.db');
  const store = Store.open(path);
  const released = new SharedArrayBuffer(4);
  const writer = new Worker(HOLD_WRITE_LOCK, { eval: true, workerData: { path, holdMs: 300, released } });
  await once(writer, 'message');

  try {
    store.insertRun(sampleRun({ id: 'while-locked' }));
    assert.equal(Atomics.load(new Int32Array(released), 0), 1, 'the write should land only once the other writer lets go');
    assert.equal(store.getRun('while-locked')?.id, 'while-locked');
  } finally {
    store.close();
    await once(writer, 'exit');
  }
});

test('given a store file, when the store is opened, then the file is in write-ahead-log mode so readers never block the writers', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'forge-store-')), 'forge.db');
  Store.open(path).close();

  const db = new DatabaseSync(path);
  try {
    assert.deepEqual({ ...db.prepare('PRAGMA journal_mode').get() }, { journal_mode: 'wal' });
  } finally {
    db.close();
  }
});
