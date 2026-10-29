import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { fingerprintHash, Store } from '../src/index.ts';
import type {
  ConfigFingerprint,
  RunFingerprint,
  RunRecord,
} from '../src/index.ts';

const sampleRun = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  id: 'run-01',
  worker: 'refiner',
  harness: 'pi',
  model: 'anthropic/claude-opus-4',
  reasoningEffort: 'high',
  startTime: '2026-09-21T10:00:00.000Z',
  endTime: '2026-09-21T10:03:20.000Z',
  status: 'success',
  costStatus: 'billed',
  costUsd: 0.1234,
  costEstimated: false,
  unconfirmedEstimateUsd: 0,
  listPrice: null,
  inputTokens: 4200,
  outputTokens: 850,
  cacheReadTokens: 3100,
  cacheWriteTokens: 600,
  transcriptRef: 'run-01.jsonl',
  sessionId: 'sess-abc',
  error: null,
  ticket: null,
  aliveAt: '2026-09-21T10:03:00.000Z',
  harnessStartTime: null,
  timeoutSeconds: null,
  maxCostUsd: null,
  exceededLimit: null,
  counters: null,
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
    aliveAt: null,
    harnessStartTime: null,
    timeoutSeconds: null,
    maxCostUsd: null,
    exceededLimit: null,
    counters: null,
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
      costEstimated: false,
      unconfirmedEstimateUsd: 0,
      listPrice: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      transcriptRef: 'run-final.jsonl',
      sessionId: null,
      error: null,
      aliveAt: null,
      harnessStartTime: null,
      timeoutSeconds: null,
      maxCostUsd: null,
      exceededLimit: null,
      counters: null,
    }),
  );

  store.finalizeRun('run-final', {
    endTime: '2026-09-21T10:03:20.000Z',
    status: 'success',
    sessionId: 'sess-final',
    error: null,
  });

  assert.deepEqual(store.getRun('run-final'), {
    id: 'run-final',
    worker: 'refiner',
    harness: 'pi',
    model: 'anthropic/claude-opus-4',
    reasoningEffort: 'high',
    startTime: '2026-09-21T10:00:00.000Z',
    endTime: '2026-09-21T10:03:20.000Z',
    status: 'success',
    costStatus: 'billed',
    costUsd: 0,
    costEstimated: false,
    unconfirmedEstimateUsd: 0,
    listPrice: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    transcriptRef: 'run-final.jsonl',
    sessionId: 'sess-final',
    error: null,
    ticket: null,
    aliveAt: null,
    harnessStartTime: null,
    timeoutSeconds: null,
    maxCostUsd: null,
    exceededLimit: null,
    counters: null,
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

test('given a store whose skill loads were recorded before coverage, when it is opened, then those loads read back with unknown coverage and a later record of the same load adds its coverage and keeps its source', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'forge-store-')), 'forge.db');
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE skill_loads (
      run_id    TEXT NOT NULL,
      subagent  TEXT NOT NULL,
      skill     TEXT NOT NULL,
      source    TEXT NOT NULL,
      loaded_at TEXT NOT NULL,
      PRIMARY KEY (run_id, subagent, skill)
    ) STRICT;
    INSERT INTO skill_loads VALUES
      ('run-01', '', 'work-on', 'prompt', '2026-09-21T10:00:01.000Z');
  `);
  old.close();

  const store = Store.open(path);
  const loaded = store.listSkillLoads('run-01');
  store.recordSkillLoad({
    runId: 'run-01',
    skill: 'work-on',
    source: 'read',
    subagent: null,
    loadedAt: '2026-09-21T10:05:00.000Z',
    coverage: { coveredLines: 60, totalLines: 142 },
  });
  const updated = store.listSkillLoads('run-01');
  store.close();

  assert.deepEqual(loaded.map(({ skill, coverage }) => ({ skill, coverage })), [
    { skill: 'work-on', coverage: null },
  ]);
  assert.deepEqual(
    updated.map(({ source, loadedAt, coverage }) => ({ source, loadedAt, coverage })),
    [
      {
        source: 'prompt',
        loadedAt: '2026-09-21T10:00:01.000Z',
        coverage: { coveredLines: 60, totalLines: 142 },
      },
    ],
  );
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

test('given a store file whose runs predate heartbeats, holding a run left running, when the store is opened, then that run reads back with no heartbeat and a run with one round-trips', () => {
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
      error          TEXT,
      repository     TEXT,
      ticket_number  INTEGER,
      ticket_url     TEXT,
      cache_read_tokens  INTEGER,
      cache_write_tokens INTEGER,
      cost_estimated     INTEGER NOT NULL DEFAULT 0,
      input_price        REAL,
      output_price       REAL,
      cache_read_price   REAL,
      cache_write_price  REAL
    ) STRICT;
    INSERT INTO runs (
      id, worker, harness, model, start_time, end_time, status,
      cost_status, cost_usd, input_tokens, output_tokens
    ) VALUES
      ('stuck', 'refiner', 'pi', 'z-ai/glm-5', '2026-09-21T10:00:00.000Z', NULL, 'running', 'pending', 0, 0, 0);
  `);
  old.close();
  const beating = sampleRun({ id: 'beating', startTime: '2026-09-21T11:00:00.000Z' });

  const store = Store.open(path);
  store.insertRun(beating);

  assert.equal(store.getRun('stuck')?.aliveAt, null);
  assert.deepEqual(store.getRun('beating'), beating);
  store.close();
  Store.open(path).close();
});

test('given generations whose token counts are each the largest safe integer, when the run totals are read, then they are held at that integer so the run stays readable', () => {
  const store = Store.open(':memory:');
  store.insertRun(sampleRun({ id: 'huge', status: 'running', endTime: null }));
  const most = Number.MAX_SAFE_INTEGER;
  for (const generationId of ['gen-a', 'gen-b']) {
    store.recordGeneration({
      runId: 'huge',
      generationId,
      subagent: null,
      kind: 'message',
      usage: { inputTokens: most, outputTokens: most, cacheReadTokens: most, cacheWriteTokens: most },
      estimatedCostUsd: null,
      createdAt: '2026-09-21T10:01:00.000Z',
    });
  }

  const run = store.listRuns()[0];
  assert.deepEqual(
    [run?.inputTokens, run?.outputTokens, run?.cacheReadTokens, run?.cacheWriteTokens],
    [most, most, most, most],
  );
});

test('given a store whose generations predate kinds, when it is opened twice, then every old generation reads back as a message and generations of each kind round-trip', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'forge-store-')), 'forge.db');
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE generations (
      id              INTEGER PRIMARY KEY,
      run_id          TEXT NOT NULL,
      generation_id   TEXT,
      subagent        TEXT,
      billed_cost_usd REAL,
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      last_error      TEXT,
      given_up_at     TEXT,
      created_at      TEXT NOT NULL,
      UNIQUE (run_id, generation_id)
    ) STRICT;
    INSERT INTO generations (run_id, generation_id, billed_cost_usd, created_at) VALUES
      ('old', 'gen-billed', 0.5, '2026-09-21T10:00:30.000Z'),
      ('old', 'gen-pending', NULL, '2026-09-21T10:00:40.000Z');
    INSERT INTO generations (run_id, generation_id, last_error, given_up_at, created_at) VALUES
      ('old', NULL, 'no id', '2026-09-21T10:00:50.000Z', '2026-09-21T10:00:50.000Z');
  `);
  old.close();
  Store.open(path).close();

  const store = Store.open(path);
  const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const kind of ['message', 'compaction', 'cache_warm'] as const) {
    store.recordGeneration({
      runId: 'new',
      generationId: `gen-${kind}`,
      subagent: null,
      kind,
      usage,
      estimatedCostUsd: null,
      createdAt: '2026-09-21T11:00:00.000Z',
    });
  }

  assert.deepEqual(store.listGenerations('old').map(({ kind }) => kind), ['message', 'message', 'message']);
  assert.deepEqual(store.listGenerations('new').map(({ kind }) => kind), ['message', 'compaction', 'cache_warm']);
  store.close();
});

test('given a store whose generations predate token columns, holding finished workloads with token totals, when it is opened and billing later settles a legacy generation with OpenRouter\'s native counts, then it migrates in place, the generation takes its provider, and those workloads keep their recorded totals with their cache split unknown and no list price or estimate', () => {
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
      error          TEXT,
      repository     TEXT,
      ticket_number  INTEGER,
      ticket_url     TEXT
    ) STRICT;
    CREATE TABLE generations (
      id              INTEGER PRIMARY KEY,
      run_id          TEXT NOT NULL,
      generation_id   TEXT,
      subagent        TEXT,
      billed_cost_usd REAL,
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      last_error      TEXT,
      given_up_at     TEXT,
      created_at      TEXT NOT NULL,
      UNIQUE (run_id, generation_id)
    ) STRICT;
    INSERT INTO runs VALUES
      ('billed', 'refiner', 'pi', 'z-ai/glm-5', '2026-09-21T10:00:00.000Z', '2026-09-21T10:01:00.000Z', 'success', 'billed', 0.5, 1200, 40, 'billed.jsonl', 'sess-1', NULL, NULL, NULL, NULL),
      ('settling', 'refiner', 'pi', 'z-ai/glm-5', '2026-09-21T11:00:00.000Z', '2026-09-21T11:01:00.000Z', 'success', 'pending', 0, 2500, 65, 'settling.jsonl', 'sess-2', NULL, NULL, NULL, NULL);
    INSERT INTO generations (run_id, generation_id, billed_cost_usd, created_at) VALUES
      ('billed', 'gen-billed', 0.5, '2026-09-21T10:00:30.000Z'),
      ('settling', 'gen-settling', NULL, '2026-09-21T11:00:30.000Z');
  `);
  old.close();

  const store = Store.open(path);
  const [unsettled] = store.unsettledGenerations();
  assert.ok(unsettled);
  store.recordLookups(
    [{
      id: unsettled.id,
      billing: {
        costUsd: 0.25,
        usage: { promptTokens: 3000, cacheReadTokens: 400, outputTokens: 70 },
        reasoningTokens: 5,
        provider: 'Z.AI',
        model: null,
      },
    }],
    '2026-09-21T11:02:00.000Z',
  );

  assert.deepEqual(
    store.listRuns().map(({ id, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, costEstimated, listPrice }) => ({
      id, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, costEstimated, listPrice,
    })),
    [
      { id: 'settling', inputTokens: 2500, outputTokens: 65, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 0.25, costEstimated: false, listPrice: null },
      { id: 'billed', inputTokens: 1200, outputTokens: 40, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 0.5, costEstimated: false, listPrice: null },
    ],
  );
  assert.deepEqual(
    store.listGenerations('billed').map(({ usage, estimatedCostUsd }) => ({ usage, estimatedCostUsd })),
    [{ usage: null, estimatedCostUsd: null }],
  );
  assert.deepEqual(
    store.listGenerations('settling').map(({ usage, reasoningTokens, provider }) => ({ usage, reasoningTokens, provider })),
    [{ usage: null, reasoningTokens: 5, provider: 'Z.AI' }],
  );
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
      { repository: 'fresh', github: 'rameezk/fresh', polledAt: null, lastError: { message: 'GitHub token missing', failedAt }, tickets: [], closed: [], requests: [] },
    ]);
  } finally {
    store.close();
  }
});

test('given a store file whose frontier snapshot predates queued tickets, when the store is opened, then the stale snapshot is dropped and a queued ticket labelled forge:ready can be stored', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'forge-store-')), 'forge.db');
  Store.open(path).close();
  const old = new DatabaseSync(path);
  old.exec(`
    DROP TABLE frontier_tickets;
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
    INSERT INTO frontier_repositories VALUES ('forge', 'rameezk/forge', '2026-09-29T08:00:00.000Z', NULL, NULL);
    INSERT INTO frontier_tickets VALUES ('forge', 56, 'Stale', 'https://github.com/rameezk/forge/issues/56', NULL, NULL, '2026-09-28T10:07:58Z');
  `);
  old.close();

  const store = Store.open(path);
  try {
    assert.deepEqual(store.listFrontier(), []);
    const queued = {
      number: 64,
      title: 'Pinned host key and just ssh',
      url: 'https://github.com/rameezk/forge/issues/64',
      parent: null,
      createdAt: '2026-09-28T11:32:31Z',
      forgeReady: true,
      blocked: true,
      forHuman: false,
      blockedBy: [],
    };
    store.replaceFrontier({ repository: 'forge', github: 'rameezk/forge', polledAt: '2026-09-29T08:20:00.000Z', closed: [], requests: [], tickets: [queued] });
    assert.deepEqual(store.listFrontier()[0]?.tickets, [queued]);
  } finally {
    store.close();
  }
});

test('given a store file whose frontier snapshot predates spec URLs, when the store is opened, then the stale snapshot is dropped and a ticket with a spec URL can be stored', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'forge-store-')), 'forge.db');
  Store.open(path).close();
  const old = new DatabaseSync(path);
  old.exec(`
    DROP TABLE frontier_tickets;
    CREATE TABLE frontier_tickets (
      repository    TEXT NOT NULL REFERENCES frontier_repositories (repository) ON DELETE CASCADE,
      number        INTEGER NOT NULL,
      title         TEXT NOT NULL,
      url           TEXT NOT NULL,
      parent_number INTEGER,
      parent_title  TEXT,
      created_at    TEXT NOT NULL,
      forge_ready   INTEGER NOT NULL,
      blocked       INTEGER NOT NULL,
      PRIMARY KEY (repository, number)
    ) STRICT;
    INSERT INTO frontier_repositories VALUES ('forge', 'rameezk/forge', '2026-09-29T08:00:00.000Z', NULL, NULL);
    INSERT INTO frontier_tickets VALUES ('forge', 56, 'Stale', 'https://github.com/rameezk/forge/issues/56', NULL, NULL, '2026-09-28T10:07:58Z', 0, 0);
  `);
  old.close();

  const store = Store.open(path);
  try {
    assert.deepEqual(store.listFrontier(), []);
    const specced = {
      number: 64,
      title: 'Pinned host key and just ssh',
      url: 'https://github.com/rameezk/forge/issues/64',
      parent: { number: 54, title: 'Frontier discovery', url: 'https://github.com/rameezk/forge/issues/54' },
      createdAt: '2026-09-28T11:32:31Z',
      forgeReady: true,
      blocked: true,
      forHuman: false,
      blockedBy: [],
    };
    store.replaceFrontier({ repository: 'forge', github: 'rameezk/forge', polledAt: '2026-09-29T08:20:00.000Z', closed: [], requests: [], tickets: [specced] });
    assert.deepEqual(store.listFrontier()[0]?.tickets, [specced]);
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

test('given a run recorded under a timeout, when it is finalized as exceeded on that limit, then it reads back with the status, the limit, its timeout and when its harness started', () => {
  const store = Store.open(':memory:');
  store.insertRun(
    sampleRun({ id: 'slow', status: 'running', endTime: null, timeoutSeconds: 7200 }),
  );
  store.markHarnessStarted('slow', '2026-09-21T10:00:30.000Z');
  store.finalizeRun('slow', {
    endTime: '2026-09-21T12:00:30.000Z',
    status: 'exceeded',
    sessionId: null,
    error: 'the workload was stopped after its timeout was exceeded',
    exceededLimit: 'timeout',
  });

  const run = store.getRun('slow');
  assert.equal(run?.status, 'exceeded');
  assert.equal(run?.exceededLimit, 'timeout');
  assert.equal(run?.timeoutSeconds, 7200);
  assert.equal(run?.harnessStartTime, '2026-09-21T10:00:30.000Z');
  store.close();
});

test('given a store file whose runs predate limits, holding a finished run, when the store is opened, then that run reads back with no timeout, budget, harness start or exceeded limit and a run with them round-trips', () => {
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
      error          TEXT,
      repository     TEXT,
      ticket_number  INTEGER,
      ticket_url     TEXT,
      cache_read_tokens  INTEGER,
      cache_write_tokens INTEGER,
      cost_estimated     INTEGER NOT NULL DEFAULT 0,
      input_price        REAL,
      output_price       REAL,
      cache_read_price   REAL,
      cache_write_price  REAL,
      reasoning_effort   TEXT,
      alive_at           TEXT
    ) STRICT;
    INSERT INTO runs (
      id, worker, harness, model, start_time, end_time, status,
      cost_status, cost_usd, input_tokens, output_tokens
    ) VALUES
      ('past', 'refiner', 'pi', 'z-ai/glm-5', '2026-09-21T10:00:00.000Z', '2026-09-21T10:05:00.000Z', 'success', 'billed', 0, 0, 0);
  `);
  old.close();
  const limited = sampleRun({
    id: 'limited',
    status: 'exceeded',
    harnessStartTime: '2026-09-21T11:00:10.000Z',
    timeoutSeconds: 60,
    maxCostUsd: 5,
    exceededLimit: 'timeout',
  });

  const store = Store.open(path);
  store.insertRun(limited);

  const past = store.getRun('past');
  assert.equal(past?.harnessStartTime, null);
  assert.equal(past?.timeoutSeconds, null);
  assert.equal(past?.maxCostUsd, null);
  assert.equal(past?.exceededLimit, null);
  assert.deepEqual(store.getRun('limited'), limited);
  store.close();
  Store.open(path).close();
});

const aRunFingerprint = (overrides: Partial<RunFingerprint> = {}): RunFingerprint => {
  const fingerprint: ConfigFingerprint = {
    model: 'z-ai/glm-5',
    reasoningEffort: null,
    harnessArgs: ['--skill', '/opt/skills/review'],
    harnessVersion: '1.0.0',
    promptTemplate: 'p1',
    systemPrompt: 's1',
    tools: 't1',
    skills: null,
  };
  return {
    fingerprint,
    hash: fingerprintHash(fingerprint),
    forgeGitSha: 'abc1234',
    baseCommit: null,
    ...overrides,
  };
};

test('given a recorded run, when its fingerprint is recorded, then it reads back whole and a run without one reads back as none', () => {
  const store = Store.open(':memory:');
  store.insertRun(sampleRun({ id: 'with' }));
  store.insertRun(sampleRun({ id: 'without' }));
  const recorded = aRunFingerprint({ baseCommit: 'deadbeef' });

  store.recordFingerprint('with', recorded);

  assert.deepEqual(store.getFingerprint('with'), recorded);
  assert.equal(store.getFingerprint('without'), null);
  assert.equal(store.getFingerprint('missing'), null);
});

test('given a run whose fingerprint is already recorded, when another is recorded for it, then the first stands', () => {
  const store = Store.open(':memory:');
  store.insertRun(sampleRun());
  const first = aRunFingerprint();

  store.recordFingerprint('run-01', first);
  store.recordFingerprint('run-01', aRunFingerprint({ forgeGitSha: 'other' }));

  assert.deepEqual(store.getFingerprint('run-01'), first);
});

test('given a store file whose runs predate fingerprints, when the store is opened, then its runs have no fingerprint and a new run can record one', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'forge-store-')), 'forge.db');
  const first = Store.open(path);
  first.insertRun(sampleRun({ id: 'old' }));
  first.close();
  const old = new DatabaseSync(path);
  old.exec(`
    ALTER TABLE runs DROP COLUMN fingerprint;
    ALTER TABLE runs DROP COLUMN fingerprint_hash;
    ALTER TABLE runs DROP COLUMN forge_git_sha;
    ALTER TABLE runs DROP COLUMN base_commit;
  `);
  old.close();

  const store = Store.open(path);
  store.insertRun(sampleRun({ id: 'new' }));
  store.recordFingerprint('new', aRunFingerprint());

  assert.equal(store.getFingerprint('old'), null);
  assert.deepEqual(store.getFingerprint('new'), aRunFingerprint());
  store.close();
  Store.open(path).close();
});

test('given a store file whose dispatches predate pull request tracking, when the store is opened twice, then the old dispatch reads back with no pull request and a new one records its pull request', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'forge-store-')), 'forge.db');
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE dispatches (
      id         INTEGER PRIMARY KEY,
      repository TEXT NOT NULL,
      number     INTEGER NOT NULL,
      url        TEXT NOT NULL,
      run_id     TEXT,
      state      TEXT NOT NULL,
      reason     TEXT,
      detail     TEXT,
      started_at TEXT NOT NULL,
      alive_at   TEXT NOT NULL,
      ended_at   TEXT
    ) STRICT;
    INSERT INTO dispatches VALUES
      (1, 'forge', 112, 'https://github.com/rameezk/forge/issues/112', NULL, 'done', NULL, NULL, '2026-09-21T10:00:00.000Z', '2026-09-21T10:00:00.000Z', '2026-09-21T10:01:00.000Z');
  `);
  old.close();
  Store.open(path).close();

  const store = Store.open(path);
  const at = '2026-09-21T11:00:00.000Z';
  const start = store.startDispatch(
    { repository: 'forge', number: 113, url: 'https://github.com/rameezk/forge/issues/113' },
    'run-113',
    at,
    10,
  );
  assert.ok('started' in start);
  store.endDispatch(start.started, { state: 'done', pullRequest: { number: 143, url: 'https://github.com/rameezk/forge/pull/143' } }, at);

  assert.deepEqual(
    store.listDispatches(at).map(({ number, pullRequest }) => ({ number, pullRequest })),
    [
      { number: 112, pullRequest: null },
      { number: 113, pullRequest: { number: 143, url: 'https://github.com/rameezk/forge/pull/143', state: 'open', settledAt: null, rework: null } },
    ],
  );
  store.close();
});

const usageOf = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

test('given a subscription run with two generations, when it ends and the store settles it, then no generation awaits billing, the run stays subscription with its tokens summed and no cost', () => {
  const store = Store.open(':memory:');
  store.insertRun(
    sampleRun({
      status: 'running',
      endTime: null,
      costStatus: 'subscription',
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    }),
  );
  for (const [generationId, input] of [['msg_1', 100], ['msg_2', 250]] as const) {
    store.recordGeneration({
      runId: 'run-01',
      generationId,
      subagent: null,
      kind: 'message',
      usage: usageOf(input, 10),
      estimatedCostUsd: null,
      createdAt: '2026-09-21T10:01:00.000Z',
    });
  }

  assert.deepEqual(store.unsettledGenerations(), []);

  store.finalizeRun('run-01', {
    endTime: '2026-09-21T10:03:20.000Z',
    status: 'success',
    sessionId: 'sess-abc',
    error: null,
  });

  const run = store.getRun('run-01');
  assert.equal(run?.costStatus, 'subscription');
  assert.equal(run?.costUsd, 0);
  assert.equal(run?.costEstimated, false);
  assert.equal(run?.inputTokens, 350);
  assert.equal(run?.outputTokens, 20);
  assert.deepEqual(store.unsettledGenerations(), []);
});

test('given a subscription run whose runner stopped heartbeating, when the store interrupts it, then it stays subscription and nothing awaits billing', () => {
  const store = Store.open(':memory:');
  store.insertRun(
    sampleRun({
      status: 'running',
      endTime: null,
      costStatus: 'subscription',
      costUsd: 0,
      aliveAt: '2026-09-21T10:00:00.000Z',
    }),
  );

  const interrupted = store.interruptStaleRuns(
    '2026-09-21T11:00:00.000Z',
    '2026-09-21T11:05:00.000Z',
  );

  assert.equal(interrupted.length, 1);
  assert.equal(store.getRun('run-01')?.status, 'interrupted');
  assert.equal(store.getRun('run-01')?.costStatus, 'subscription');
  assert.deepEqual(store.unsettledGenerations(), []);
});

test('given a billed run and a subscription run each with a generation, when the store lists what awaits billing, then only the billed run\'s generation is listed', () => {
  const store = Store.open(':memory:');
  store.insertRun(sampleRun({ id: 'run-billed', costStatus: 'pending' }));
  store.insertRun(sampleRun({ id: 'run-sub', costStatus: 'subscription' }));
  for (const runId of ['run-billed', 'run-sub']) {
    store.recordGeneration({
      runId,
      generationId: `gen-of-${runId}`,
      subagent: null,
      kind: 'message',
      usage: usageOf(10, 5),
      estimatedCostUsd: null,
      createdAt: '2026-09-21T10:01:00.000Z',
    });
  }

  assert.deepEqual(
    store.unsettledGenerations().map(({ generationId }) => generationId),
    ['gen-of-run-billed'],
  );
});

const CONFLICTING_PULL_REQUEST = {
  repository: 'forge',
  number: 143,
  url: 'https://github.com/rameezk/forge/pull/143',
};

test('given a conflict resolution left running past the heartbeat window, when conflict resolutions are listed, then it reads as interrupted, and it no longer counts toward the pool or holds the pull request', () => {
  const store = Store.open(':memory:');
  const started = '2026-09-21T10:00:00.000Z';
  const start = store.startConflictResolution(CONFLICTING_PULL_REQUEST, [], 'run-01', started, 1, { headSha: 'head-a', defaultSha: 'default-a' });
  assert.ok('started' in start);
  assert.equal(store.liveWorkloads(started), 1);

  const later = '2026-09-21T11:00:00.000Z';

  assert.deepEqual(store.listConflictResolutions(later).map(({ state, reason }) => ({ state, reason })), [{ state: 'failed', reason: 'interrupted' }]);
  assert.equal(store.liveWorkloads(later), 0);
  assert.ok('started' in store.startRevision(CONFLICTING_PULL_REQUEST, [], 'run-02', later, 1));
});

test('given a conflict resolution that ends in failure, when conflict resolutions are listed, then its state, reason and detail read back', () => {
  const store = Store.open(':memory:');
  const start = store.startConflictResolution(CONFLICTING_PULL_REQUEST, [], 'run-01', '2026-09-21T10:00:00.000Z', 1, { headSha: 'head-a', defaultSha: 'default-a' });
  assert.ok('started' in start);

  store.endConflictResolution(start.started, 'failed', '2026-09-21T10:05:00.000Z', {
    reason: 'not-merged',
    detail: 'the head does not contain abc',
  });

  assert.deepEqual(
    store.listConflictResolutions('2026-09-21T10:06:00.000Z').map(({ state, reason, detail, endedAt }) => ({ state, reason, detail, endedAt })),
    [{ state: 'failed', reason: 'not-merged', detail: 'the head does not contain abc', endedAt: '2026-09-21T10:05:00.000Z' }],
  );
});

const PAIR = { headSha: 'head-a', defaultSha: 'default-a' };

const failToStart = (store: Store, runId: string, at: string, detail: string, pair = PAIR): void => {
  const start = store.startConflictResolution(CONFLICTING_PULL_REQUEST, [], runId, at, 10, pair);
  assert.ok('started' in start);
  store.failConflictResolutionStart(start.started, detail, at);
};

test('given a conflict resolution that fails before its harness starts, when conflict resolutions are listed, then it reads as a failed start with no run, its reason and its detail', () => {
  const store = Store.open(':memory:');

  failToStart(store, 'run-01', '2026-09-21T10:00:00.000Z', 'clone failed');

  assert.deepEqual(
    store.listConflictResolutions('2026-09-21T10:01:00.000Z').map(({ runId, state, reason, detail, failedStarts }) => ({ runId, state, reason, detail, failedStarts })),
    [{ runId: null, state: 'failed', reason: 'not-started', detail: 'clone failed', failedStarts: 1 }],
  );
  assert.equal(store.liveWorkloads('2026-09-21T10:01:00.000Z'), 0);
});

test('given a conflict resolution whose latest record is a failed start, when it fails to start again, then one record is kept with the count raised and the latest detail and sha pair', () => {
  const store = Store.open(':memory:');
  failToStart(store, 'run-01', '2026-09-21T10:00:00.000Z', 'first');

  failToStart(store, 'run-02', '2026-09-21T10:05:00.000Z', 'second', { headSha: 'head-b', defaultSha: 'default-b' });

  assert.deepEqual(
    store.listConflictResolutions('2026-09-21T10:06:00.000Z').map(({ failedStarts, detail, endedAt }) => ({ failedStarts, detail, endedAt })),
    [{ failedStarts: 2, detail: 'second', endedAt: '2026-09-21T10:05:00.000Z' }],
  );
});

test('given a conflict resolution that ran and failed, when the next one fails to start, then the failed start is its own record with a count of one', () => {
  const store = Store.open(':memory:');
  const ran = store.startConflictResolution(CONFLICTING_PULL_REQUEST, [], 'run-01', '2026-09-21T10:00:00.000Z', 10, PAIR);
  assert.ok('started' in ran);
  store.endConflictResolution(ran.started, 'failed', '2026-09-21T10:05:00.000Z', { reason: 'crashed', detail: null });

  failToStart(store, 'run-02', '2026-09-21T10:10:00.000Z', 'clone failed');

  assert.deepEqual(
    store.listConflictResolutions('2026-09-21T10:11:00.000Z').map(({ runId, reason, failedStarts }) => ({ runId, reason, failedStarts })),
    [{ runId: 'run-01', reason: 'crashed', failedStarts: null }, { runId: null, reason: 'not-started', failedStarts: 1 }],
  );
});

test('given a database from before failed starts, when it is opened, then its conflict resolutions read back and a failed start can be recorded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-store-'));
  const path = join(dir, 'forge.db');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE conflict_resolutions (
      id INTEGER PRIMARY KEY, repository TEXT NOT NULL, number INTEGER NOT NULL, url TEXT NOT NULL,
      run_id TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, detail TEXT,
      started_at TEXT NOT NULL, alive_at TEXT NOT NULL, ended_at TEXT
    ) STRICT;
    INSERT INTO conflict_resolutions (repository, number, url, run_id, state, reason, started_at, alive_at, ended_at)
    VALUES ('forge', 143, 'https://github.com/rameezk/forge/pull/143', 'run-old', 'error', 'crashed',
      '2026-09-21T09:00:00.000Z', '2026-09-21T09:00:00.000Z', '2026-09-21T09:05:00.000Z');
  `);
  legacy.close();

  const store = Store.open(path);
  failToStart(store, 'run-01', '2026-09-21T10:00:00.000Z', 'clone failed');

  assert.deepEqual(
    store.listConflictResolutions('2026-09-21T10:01:00.000Z').map(({ runId, reason }) => ({ runId, reason })),
    [{ runId: 'run-old', reason: 'crashed' }, { runId: null, reason: 'not-started' }],
  );
});

const REVISED = { repository: 'forge', number: 143, url: 'https://github.com/rameezk/forge/pull/143' };

const watched = (newestFeedbackAt: string | null) => ({
  number: 143,
  url: REVISED.url,
  closes: [] as number[],
  newestFeedbackAt,
  mergeable: 'MERGEABLE' as const,
  headSha: 'head-a',
  defaultSha: 'default-a',
});

const startedRevision = (store: Store, at: string): { id: number; after: string | null } => {
  const start = store.startRevision(REVISED, [], `run-${at}`, at, Number.POSITIVE_INFINITY);
  assert.ok('started' in start);
  return { id: start.started, after: start.after };
};

const failRevisionToStart = (store: Store, at: string, detail: string): void => {
  store.failRevisionStart(startedRevision(store, at).id, detail, at);
};

test('given a revision that fails before its harness starts, when revisions are listed, then it reads as a failed start with no run, its reason and its detail', () => {
  const store = Store.open(':memory:');

  failRevisionToStart(store, '2026-09-21T10:00:00.000Z', 'clone failed');

  assert.deepEqual(
    store.listRevisions('2026-09-21T10:01:00.000Z').map(({ runId, state, reason, detail, failedStarts }) => ({ runId, state, reason, detail, failedStarts })),
    [{ runId: null, state: 'failed', reason: 'not-started', detail: 'clone failed', failedStarts: 1 }],
  );
  assert.equal(store.liveWorkloads('2026-09-21T10:01:00.000Z'), 0);
});

test('given a revision whose latest record is a failed start, when it fails to start again, then one record is kept with the count raised and the latest detail', () => {
  const store = Store.open(':memory:');
  failRevisionToStart(store, '2026-09-21T10:00:00.000Z', 'first');

  failRevisionToStart(store, '2026-09-21T10:05:00.000Z', 'second');

  assert.deepEqual(
    store.listRevisions('2026-09-21T10:06:00.000Z').map(({ failedStarts, detail, endedAt }) => ({ failedStarts, detail, endedAt })),
    [{ failedStarts: 2, detail: 'second', endedAt: '2026-09-21T10:05:00.000Z' }],
  );
});

test('given a pull request with no revision started, when its pre-harness step fails twice, then one failed start with no run is kept with the count', () => {
  const store = Store.open(':memory:');

  store.recordRevisionStartFailure(REVISED, 'first', '2026-09-21T10:00:00.000Z');
  store.recordRevisionStartFailure(REVISED, 'second', '2026-09-21T10:05:00.000Z');

  assert.deepEqual(
    store.listRevisions('2026-09-21T10:06:00.000Z').map(({ runId, state, reason, detail, failedStarts }) => ({ runId, state, reason, detail, failedStarts })),
    [{ runId: null, state: 'failed', reason: 'not-started', detail: 'second', failedStarts: 2 }],
  );
});

test('given a live revision of the pull request, when a pre-harness failure is recorded, then nothing is recorded over it', () => {
  const store = Store.open(':memory:');
  startedRevision(store, '2026-09-21T10:00:00.000Z');

  store.recordRevisionStartFailure(REVISED, 'boom', '2026-09-21T10:00:30.000Z');

  assert.deepEqual(store.listRevisions('2026-09-21T10:00:40.000Z').map(({ state }) => state), ['running']);
});

test('given a revision that ran and failed, when the next one fails to start, then the failed start is its own record with a count of one', () => {
  const store = Store.open(':memory:');
  store.endRevision(startedRevision(store, '2026-09-21T10:00:00.000Z').id, 'failed', '2026-09-21T10:05:00.000Z', { reason: 'crashed', detail: null });

  failRevisionToStart(store, '2026-09-21T10:10:00.000Z', 'clone failed');

  assert.deepEqual(
    store.listRevisions('2026-09-21T10:11:00.000Z').map(({ reason, failedStarts }) => ({ reason, failedStarts })),
    [{ reason: 'crashed', failedStarts: null }, { reason: 'not-started', failedStarts: 1 }],
  );
});

test('given a revision whose latest record is a failed start and feedback the timer already saw, when the timer checks, then the pull request is due again', () => {
  const store = Store.open(':memory:');
  store.endRevision(startedRevision(store, '2026-09-21T10:00:00.000Z').id, 'done', '2026-09-21T10:01:00.000Z');
  store.recordWatchedPullRequests('forge', [watched('2026-09-21T10:05:00.000Z')]);
  failRevisionToStart(store, '2026-09-21T10:10:00.000Z', 'clone failed');
  store.recordWatchedPullRequests('forge', [watched('2026-09-21T10:05:00.000Z')]);

  assert.deepEqual(store.feedbackDue('2026-09-21T10:11:00.000Z', 600), [REVISED]);
});

test('given a failed start of a pull request that is no longer watched, when the timer checks, then it is not due', () => {
  const store = Store.open(':memory:');
  store.recordWatchedPullRequests('forge', [watched('2026-09-21T10:05:00.000Z')]);
  failRevisionToStart(store, '2026-09-21T10:10:00.000Z', 'clone failed');
  store.recordWatchedPullRequests('forge', []);

  assert.deepEqual(store.feedbackDue('2026-09-21T10:11:00.000Z', 600), []);
});

test('given a failed start that a later revision ran past, when the timer checks, then it is not due until newer feedback arrives', () => {
  const store = Store.open(':memory:');
  store.recordWatchedPullRequests('forge', [watched('2026-09-21T10:05:00.000Z')]);
  failRevisionToStart(store, '2026-09-21T10:10:00.000Z', 'clone failed');
  store.endRevision(startedRevision(store, '2026-09-21T10:20:00.000Z').id, 'done', '2026-09-21T10:21:00.000Z');
  store.recordWatchedPullRequests('forge', [watched('2026-09-21T10:05:00.000Z')]);

  assert.deepEqual(store.feedbackDue('2026-09-21T11:00:00.000Z', 600), []);
});

test('given a database from before revision failed starts, when it is opened, then its revisions read back and a failed start can be recorded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-store-'));
  const path = join(dir, 'forge.db');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE revisions (
      id INTEGER PRIMARY KEY, repository TEXT NOT NULL, number INTEGER NOT NULL, url TEXT NOT NULL,
      run_id TEXT NOT NULL, dispatch_id INTEGER, state TEXT NOT NULL, reason TEXT, detail TEXT,
      started_at TEXT NOT NULL, alive_at TEXT NOT NULL, ended_at TEXT, feedback_cursor TEXT
    ) STRICT;
    INSERT INTO revisions (repository, number, url, run_id, state, reason, started_at, alive_at, ended_at, feedback_cursor)
    VALUES ('forge', 143, 'https://github.com/rameezk/forge/pull/143', 'run-old', 'error', 'crashed',
      '2026-09-21T09:00:00.000Z', '2026-09-21T09:00:00.000Z', '2026-09-21T09:05:00.000Z', '2026-09-21T08:00:00.000Z');
  `);
  legacy.close();

  const store = Store.open(path);
  failRevisionToStart(store, '2026-09-21T10:00:00.000Z', 'clone failed');

  assert.deepEqual(
    store.listRevisions('2026-09-21T10:01:00.000Z').map(({ runId, reason }) => ({ runId, reason })),
    [{ runId: 'run-old', reason: 'crashed' }, { runId: null, reason: 'not-started' }],
  );
});

for (const state of ['failed', 'exceeded', 'interrupted'] as const) {
  test(`given a revision that ended ${state}, when the next revision starts, then its window begins where the failed one's began`, () => {
    const store = Store.open(':memory:');
    store.endRevision(startedRevision(store, '2026-09-21T10:00:00.000Z').id, 'done', '2026-09-21T10:01:00.000Z');
    const failed = startedRevision(store, '2026-09-21T10:10:00.000Z');
    store.endRevision(failed.id, 'failed', '2026-09-21T10:11:00.000Z', state === 'failed' ? undefined : { reason: state, detail: null });

    assert.equal(startedRevision(store, '2026-09-21T10:20:00.000Z').after, '2026-09-21T10:00:00.000Z');
  });
}

test('given a revision that ended ok, when the next revision starts, then its window begins where the ok one began', () => {
  const store = Store.open(':memory:');
  store.endRevision(startedRevision(store, '2026-09-21T10:00:00.000Z').id, 'done', '2026-09-21T10:01:00.000Z');

  assert.equal(startedRevision(store, '2026-09-21T10:10:00.000Z').after, '2026-09-21T10:00:00.000Z');
});

test('given a first revision that ended in error, when the next revision starts, then its window has no beginning', () => {
  const store = Store.open(':memory:');
  store.endRevision(startedRevision(store, '2026-09-21T10:00:00.000Z').id, 'failed', '2026-09-21T10:01:00.000Z');

  assert.equal(startedRevision(store, '2026-09-21T10:10:00.000Z').after, null);
});

test('given a revision that ended error over feedback the timer saw, when the timer checks later, then the pull request is not due until newer feedback arrives', () => {
  const store = Store.open(':memory:');
  store.endRevision(startedRevision(store, '2026-09-21T10:00:00.000Z').id, 'done', '2026-09-21T10:01:00.000Z');
  store.recordWatchedPullRequests('forge', [watched('2026-09-21T10:05:00.000Z')]);
  store.endRevision(startedRevision(store, '2026-09-21T10:10:00.000Z').id, 'failed', '2026-09-21T10:11:00.000Z');

  store.recordWatchedPullRequests('forge', [watched('2026-09-21T10:05:00.000Z')]);
  assert.deepEqual(store.feedbackDue('2026-09-21T11:00:00.000Z', 600), []);

  store.recordWatchedPullRequests('forge', [watched('2026-09-21T10:30:00.000Z')]);
  assert.deepEqual(store.feedbackDue('2026-09-21T11:00:00.000Z', 600), [REVISED]);
});

test('given a revision that ended error and then new feedback, when the next revision starts, then its window begins before the failed revision so it holds both', () => {
  const store = Store.open(':memory:');
  store.endRevision(startedRevision(store, '2026-09-21T10:00:00.000Z').id, 'done', '2026-09-21T10:01:00.000Z');
  store.endRevision(startedRevision(store, '2026-09-21T10:10:00.000Z').id, 'failed', '2026-09-21T10:11:00.000Z');
  store.recordWatchedPullRequests('forge', [watched('2026-09-21T10:30:00.000Z')]);

  assert.equal(startedRevision(store, '2026-09-21T10:40:00.000Z').after, '2026-09-21T10:00:00.000Z');
});

test('given a revision left running with a stale heartbeat, when a new revision starts, then the stale one is interrupted and the new window begins where the stale one began', () => {
  const store = Store.open(':memory:');
  store.endRevision(startedRevision(store, '2026-09-21T10:00:00.000Z').id, 'done', '2026-09-21T10:01:00.000Z');
  const stale = startedRevision(store, '2026-09-21T10:10:00.000Z');

  const next = startedRevision(store, '2026-09-21T11:00:00.000Z');

  assert.equal(next.after, '2026-09-21T10:00:00.000Z');
  assert.equal(store.listRevisions('2026-09-21T11:00:00.000Z').find(({ id }) => id === stale.id)?.reason, 'interrupted');
});

test('given a repository with stored requests, when its frontier is replaced, then only the new requests remain', () => {
  const store = Store.open(':memory:');
  try {
    const request = (number: number) => ({ number, title: `Request ${number}`, url: `https://github.com/rameezk/forge/issues/${number}`, createdAt: '2026-10-01T06:17:03Z' });
    const polled = (requests: ReturnType<typeof request>[]) => ({ repository: 'forge', github: 'rameezk/forge', polledAt: '2026-10-01T07:00:00.000Z', tickets: [], closed: [], requests });

    store.replaceFrontier(polled([request(1), request(2)]));
    store.replaceFrontier(polled([request(2), request(3)]));

    assert.deepEqual(store.listFrontier()[0]?.requests, [request(2), request(3)]);
  } finally {
    store.close();
  }
});

test('given a store file whose unconfirmed run predates the unconfirmed estimate, when the store is opened, then the run reads back with the estimate of its given-up generations and none of the billed one', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'forge-store-')), 'forge.db');
  const before = Store.open(path);
  before.insertRun(sampleRun({ id: 'old', status: 'running', endTime: null, costStatus: 'pending', costUsd: 0 }));
  const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const [generationId, estimatedCostUsd] of [['gen-billed', 0.1], ['msg_01', 0.25], ['msg_02', 0.11]] as const) {
    before.recordGeneration({ runId: 'old', generationId, subagent: null, kind: 'message', usage, estimatedCostUsd, createdAt: '2026-09-21T10:01:00.000Z' });
  }
  before.recordLookups(
    [
      { id: before.unsettledGenerations()[0]?.id ?? 0, billing: { costUsd: 0.12, usage: null, reasoningTokens: null, provider: null, model: null } },
      ...before.unsettledGenerations().slice(1).map(({ id }) => ({ id, error: 'HTTP 400', givenUp: true as const })),
    ],
    '2026-09-21T10:05:00.000Z',
  );
  before.close();
  const raw = new DatabaseSync(path);
  raw.exec('ALTER TABLE runs DROP COLUMN unconfirmed_estimate_usd');
  raw.close();

  const store = Store.open(path);

  const run = store.getRun('old');
  assert.equal(run?.costStatus, 'unconfirmed');
  assert.equal(run?.costUsd, 0.12);
  assert.equal(run?.unconfirmedEstimateUsd, 0.36);
  store.close();
});

for (const [table, list] of [['revisions', 'listRevisions'], ['conflict_resolutions', 'listConflictResolutions']] as const) {
  test(`given ${table} recorded as ok, error, exceeded and interrupted, when the store is opened, then they read as done, failed with their reason, failed exceeded with its limit, and failed interrupted`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-store-'));
    const path = join(dir, 'forge.db');
    const seeded = Store.open(path);
    seeded.insertRun(sampleRun({ id: 'run-over', status: 'exceeded', exceededLimit: 'budget' }));
    seeded.close();
    const raw = new DatabaseSync(path);
    const insert = raw.prepare(
      `INSERT INTO ${table} (repository, number, url, run_id, state, reason, detail, started_at, alive_at, ended_at)
      VALUES ('forge', $number, 'https://github.com/rameezk/forge/pull/1', $run_id, $state, $reason, $detail,
        '2026-09-21T09:00:00.000Z', '2026-09-21T09:00:00.000Z', '2026-09-21T09:05:00.000Z')`,
    );
    insert.run({ number: 1, run_id: null, state: 'ok', reason: null, detail: null });
    insert.run({ number: 2, run_id: null, state: 'error', reason: 'crashed', detail: 'boom' });
    insert.run({ number: 3, run_id: 'run-over', state: 'exceeded', reason: null, detail: null });
    insert.run({ number: 4, run_id: null, state: 'interrupted', reason: null, detail: null });
    raw.close();

    const store = Store.open(path);

    assert.deepEqual(
      store[list]('2026-09-21T09:06:00.000Z').map(({ state, reason, detail }) => ({ state, reason, detail })),
      [
        { state: 'done', reason: null, detail: null },
        { state: 'failed', reason: 'crashed', detail: 'boom' },
        { state: 'failed', reason: 'exceeded', detail: 'budget' },
        { state: 'failed', reason: 'interrupted', detail: null },
      ],
    );
    store.close();
  });
}
