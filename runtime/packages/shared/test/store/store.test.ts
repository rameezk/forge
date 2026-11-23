import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { Store } from '../../src/index.ts';
import { openConnection, type Connection } from '../../src/store/connection.ts';
import { CONCERNS, migrate } from '../../src/store/migrate.ts';
import { columnsOf, sampleRun } from './support.ts';

test('given a current store file where another connection holds a write transaction, when the store is opened, then it opens without waiting on that writer', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'forge-store-')), 'forge.db');
  Store.open(path).close();
  const writer = new DatabaseSync(path);
  writer.exec('BEGIN IMMEDIATE');

  try {
    const store = Store.open(path);
    assert.deepEqual(store.runs.listRuns(), []);
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

test('given a store file where another process briefly holds a write transaction, when this process writes a run, then the write waits for the other writer and succeeds instead of failing as busy', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'forge-store-')), 'forge.db');
  const store = Store.open(path);
  const released = new SharedArrayBuffer(4);
  const writer = new Worker(HOLD_WRITE_LOCK, { eval: true, workerData: { path, holdMs: 300, released } });
  await once(writer, 'message');

  try {
    store.runs.insertRun(sampleRun({ id: 'while-locked' }));
    assert.equal(Atomics.load(new Int32Array(released), 0), 1, 'the write should land only once the other writer lets go');
    assert.equal(store.runs.getRun('while-locked')?.id, 'while-locked');
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

test('given a forge.db with an older schema, when it is opened read-only, then the schema is unchanged', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'forge-store-')), 'forge.db');
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('CREATE TABLE runs (id TEXT PRIMARY KEY, worker TEXT NOT NULL) STRICT');
  raw.close();

  const store = Store.openReadOnly(path);
  store.close();

  assert.deepEqual(columnsOf(path, 'runs'), ['id', 'worker']);
  assert.deepEqual(columnsOf(path, 'dispatches'), []);
});

test('given a WAL-mode forge.db whose last connection has closed, when it is opened read-only, then reads succeed without WAL files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-store-'));
  const path = join(dir, 'forge.db');
  const writer = Store.open(path);
  writer.runs.insertRun(sampleRun());
  writer.close();
  assert.equal(existsSync(`${path}-wal`), false);
  assert.equal(existsSync(`${path}-shm`), false);

  const store = Store.openReadOnly(path);

  assert.deepEqual(store.runs.getRun('run-01'), sampleRun());
  store.close();
});

test('given a read-only store open alongside a writer, when it attempts an insert or a journal-mode change and the writer commits, then its attempts fail and it reads the writer row', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'forge-store-')), 'forge.db');
  const writer = Store.open(path);
  const store = Store.openReadOnly(path);

  assert.throws(() => store.runs.insertRun(sampleRun({ id: 'run-ro' })), /readonly/i);
  assert.equal(store.runs.getRun('run-ro'), undefined);
  writer.runs.insertRun(sampleRun({ id: 'run-rw' }));

  assert.deepEqual(store.runs.getRun('run-rw'), sampleRun({ id: 'run-rw' }));
  const raw = new DatabaseSync(path, { readOnly: true });
  assert.equal((raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
  raw.close();
  store.close();
  writer.close();
});

const OLDEST_RUNS = `
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
    ('uncertain', 'refiner', 'pi', 'z-ai/glm-5', '2026-09-21T11:00:00.000Z', '2026-09-21T11:01:00.000Z', 'success', 1, 0.0125, 1300, 25, 'uncertain.jsonl', 'sess-2', NULL);
`;

const schemaOf = (path: string): Record<string, string[]> => {
  const raw = new DatabaseSync(path);
  const tables = (
    raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]
  ).map(({ name }) => name);
  const schema = Object.fromEntries(
    tables.map((table) => [
      table,
      (
        raw
          .prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('${table}') ORDER BY name`)
          .all() as Record<string, unknown>[]
      ).map((column) => JSON.stringify(column)),
    ]),
  );
  const indexes = (
    raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`).all() as {
      name: string;
    }[]
  ).map(({ name }) => name);
  raw.close();
  return { ...schema, '#indexes': indexes };
};

test('given an empty database and one built at the oldest schema with rows in it, when each is opened read-write, then both end at the same schema and the old rows are migrated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-store-'));
  const fresh = join(dir, 'fresh.db');
  const old = join(dir, 'old.db');
  const seed = new DatabaseSync(old);
  seed.exec(OLDEST_RUNS);
  seed.close();

  Store.open(fresh).close();
  const migrated = Store.open(old);

  assert.deepEqual(schemaOf(old), schemaOf(fresh));
  assert.deepEqual(
    migrated.runs.listRuns().map(({ id, costStatus, costUsd }) => ({ id, costStatus, costUsd })),
    [
      { id: 'uncertain', costStatus: 'unconfirmed', costUsd: 0.0125 },
      { id: 'settled', costStatus: 'billed', costUsd: 0.00093252 },
    ],
  );
  migrated.close();
});

test('given a database at an old schema with rows, when it is opened read-only, then its schema and rows are unchanged', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'forge-store-')), 'forge.db');
  const seed = new DatabaseSync(path);
  seed.exec(OLDEST_RUNS);
  seed.close();
  const before = schemaOf(path);

  const store = Store.openReadOnly(path);
  store.close();

  assert.deepEqual(schemaOf(path), before);
  assert.ok(columnsOf(path, 'runs').includes('cost_uncertain'));
});

const OWNER_OF_TABLE: Record<string, string> = {
  runs: 'runs',
  runs_cost_uncertain: 'runs',
  generations: 'runs',
  skill_loads: 'runs',
  frontier_repositories: 'frontier',
  frontier_tickets: 'frontier',
  frontier_closed: 'frontier',
  frontier_requests: 'frontier',
  reviewer_app_checks: 'frontier',
  dispatches: 'workloads',
  revisions: 'workloads',
  revisions_required_run: 'workloads',
  conflict_resolutions: 'workloads',
  conflict_resolutions_required_run: 'workloads',
  feedback_watches: 'workloads',
  risk_grades: 'grades',
  grading_attempts: 'grades',
  urgency_grades: 'urgency',
  urgency_attempts: 'urgency',
  pull_request_holds: 'autoMerge',
  auto_merge_samples: 'autoMerge',
  auto_merge_verdicts: 'autoMerge',
  diagnoses: 'diagnoses',
  diagnosis_start: 'diagnoses',
};

const TABLE_WRITTEN_BY = /\b(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+\w+\s+ON)\s+(\w+)/gi;

const concernsInOrderOfWriting = (connection: Connection): string[] => {
  const written: string[] = [];
  const recording: Connection = {
    ...connection,
    exec: (sql) => {
      for (const [, table] of sql.matchAll(TABLE_WRITTEN_BY)) {
        const owner = OWNER_OF_TABLE[table!];
        assert.ok(owner, `table ${table} has no owning concern`);
        written.push(owner);
      }
      connection.exec(sql);
    },
  };
  migrate(recording);
  return written;
};

test('given the store migrations, when they run on a fresh database, then every concern runs its steps together in the agreed concern order', () => {
  const written = concernsInOrderOfWriting(openConnection(':memory:'));

  assert.deepEqual(
    written.filter((concern, index) => concern !== written[index - 1]),
    ['runs', 'frontier', 'workloads', 'grades', 'urgency', 'autoMerge', 'diagnoses'],
  );
  assert.deepEqual(
    CONCERNS.map(({ name }) => name),
    ['runs', 'frontier', 'workloads', 'grades', 'urgency', 'autoMerge', 'diagnoses'],
  );
});

test('given an opened store, when its interface is inspected, then runs are reached only through the runs concern', () => {
  const store = Store.open(':memory:');
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(store));
  const moved = [
    'insertRun',
    'finalizeRun',
    'getRun',
    'listRuns',
    'recordGeneration',
    'listGenerations',
    'recordLookups',
    'unsettledGenerations',
    'recordSkillLoad',
    'listSkillLoads',
    'recordFingerprint',
    'getFingerprint',
    'getCohortFingerprint',
    'listCohortFingerprints',
    'runCohorts',
    'hasUnknownConfigRuns',
  ];
  assert.deepEqual(
    methods.filter((name) => moved.includes(name)),
    [],
  );
  assert.equal(typeof store.runs.insertRun, 'function');
  store.close();
});

test('given an opened store, when its interface is inspected, then diagnoses are reached only through the diagnoses concern', () => {
  const store = Store.open(':memory:');
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(store));
  assert.deepEqual(
    methods.filter((name) => /diagnos/i.test(name)),
    [],
  );
  assert.equal(typeof store.diagnoses.startDiagnosis, 'function');
  store.close();
});
