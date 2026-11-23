import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../src/index.ts';
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
    null,
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
  draft: false,
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


