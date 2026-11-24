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
  const start = store.workloads.startDispatch(
    { repository: 'forge', number: 113, url: 'https://github.com/rameezk/forge/issues/113' },
    'run-113',
    at,
    10,
    null,
  );
  assert.ok('started' in start);
  store.workloads.endDispatch(start.started, { state: 'done', pullRequest: { number: 143, url: 'https://github.com/rameezk/forge/pull/143' } }, at);

  assert.deepEqual(
    store.workloads.listDispatches(at).map(({ number, pullRequest }) => ({ number, pullRequest })),
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
  const start = store.workloads.startConflictResolution(CONFLICTING_PULL_REQUEST, [], 'run-01', started, 1, { headSha: 'head-a', defaultSha: 'default-a' });
  assert.ok('started' in start);
  assert.equal(store.workloads.liveWorkloads(started), 1);

  const later = '2026-09-21T11:00:00.000Z';

  assert.deepEqual(store.workloads.listConflictResolutions(later).map(({ state, reason }) => ({ state, reason })), [{ state: 'failed', reason: 'interrupted' }]);
  assert.equal(store.workloads.liveWorkloads(later), 0);
  assert.ok('started' in store.workloads.startRevision(CONFLICTING_PULL_REQUEST, [], 'run-02', later, 1));
});

test('given a conflict resolution that ends in failure, when conflict resolutions are listed, then its state, reason and detail read back', () => {
  const store = Store.open(':memory:');
  const start = store.workloads.startConflictResolution(CONFLICTING_PULL_REQUEST, [], 'run-01', '2026-09-21T10:00:00.000Z', 1, { headSha: 'head-a', defaultSha: 'default-a' });
  assert.ok('started' in start);

  store.workloads.endConflictResolution(start.started, 'failed', '2026-09-21T10:05:00.000Z', {
    reason: 'not-merged',
    detail: 'the head does not contain abc',
  });

  assert.deepEqual(
    store.workloads.listConflictResolutions('2026-09-21T10:06:00.000Z').map(({ state, reason, detail, endedAt }) => ({ state, reason, detail, endedAt })),
    [{ state: 'failed', reason: 'not-merged', detail: 'the head does not contain abc', endedAt: '2026-09-21T10:05:00.000Z' }],
  );
});

const PAIR = { headSha: 'head-a', defaultSha: 'default-a' };

const failToStart = (store: Store, runId: string, at: string, detail: string, pair = PAIR): void => {
  const start = store.workloads.startConflictResolution(CONFLICTING_PULL_REQUEST, [], runId, at, 10, pair);
  assert.ok('started' in start);
  store.workloads.failConflictResolutionStart(start.started, detail, at);
};

test('given a conflict resolution that fails before its harness starts, when conflict resolutions are listed, then it reads as a failed start with no run, its reason and its detail', () => {
  const store = Store.open(':memory:');

  failToStart(store, 'run-01', '2026-09-21T10:00:00.000Z', 'clone failed');

  assert.deepEqual(
    store.workloads.listConflictResolutions('2026-09-21T10:01:00.000Z').map(({ runId, state, reason, detail, failedStarts }) => ({ runId, state, reason, detail, failedStarts })),
    [{ runId: null, state: 'failed', reason: 'not-started', detail: 'clone failed', failedStarts: 1 }],
  );
  assert.equal(store.workloads.liveWorkloads('2026-09-21T10:01:00.000Z'), 0);
});

test('given a conflict resolution whose latest record is a failed start, when it fails to start again, then one record is kept with the count raised and the latest detail and sha pair', () => {
  const store = Store.open(':memory:');
  failToStart(store, 'run-01', '2026-09-21T10:00:00.000Z', 'first');

  failToStart(store, 'run-02', '2026-09-21T10:05:00.000Z', 'second', { headSha: 'head-b', defaultSha: 'default-b' });

  assert.deepEqual(
    store.workloads.listConflictResolutions('2026-09-21T10:06:00.000Z').map(({ failedStarts, detail, endedAt }) => ({ failedStarts, detail, endedAt })),
    [{ failedStarts: 2, detail: 'second', endedAt: '2026-09-21T10:05:00.000Z' }],
  );
});

test('given a conflict resolution that ran and failed, when the next one fails to start, then the failed start is its own record with a count of one', () => {
  const store = Store.open(':memory:');
  const ran = store.workloads.startConflictResolution(CONFLICTING_PULL_REQUEST, [], 'run-01', '2026-09-21T10:00:00.000Z', 10, PAIR);
  assert.ok('started' in ran);
  store.workloads.endConflictResolution(ran.started, 'failed', '2026-09-21T10:05:00.000Z', { reason: 'crashed', detail: null });

  failToStart(store, 'run-02', '2026-09-21T10:10:00.000Z', 'clone failed');

  assert.deepEqual(
    store.workloads.listConflictResolutions('2026-09-21T10:11:00.000Z').map(({ runId, reason, failedStarts }) => ({ runId, reason, failedStarts })),
    [{ runId: 'run-01', reason: 'crashed', failedStarts: null }, { runId: null, reason: 'not-started', failedStarts: 1 }],
  );
});

test('given a pull request with no conflict resolution started, when its pre-harness step fails twice, then one failed start with no run is kept with the count', () => {
  const store = Store.open(':memory:');

  store.workloads.recordConflictResolutionStartFailure(CONFLICTING_PULL_REQUEST, 'first', '2026-09-21T10:00:00.000Z');
  store.workloads.recordConflictResolutionStartFailure(CONFLICTING_PULL_REQUEST, 'second', '2026-09-21T10:05:00.000Z');

  assert.deepEqual(
    store.workloads.listConflictResolutions('2026-09-21T10:06:00.000Z').map(({ runId, state, reason, detail, failedStarts }) => ({ runId, state, reason, detail, failedStarts })),
    [{ runId: null, state: 'failed', reason: 'not-started', detail: 'second', failedStarts: 2 }],
  );
});

test('given a conflict resolution that already failed to start after starting, when a pre-harness failure is recorded, then it is folded into that one with the count raised', () => {
  const store = Store.open(':memory:');
  failToStart(store, 'run-01', '2026-09-21T10:00:00.000Z', 'first');

  store.workloads.recordConflictResolutionStartFailure(CONFLICTING_PULL_REQUEST, 'second', '2026-09-21T10:05:00.000Z');

  assert.deepEqual(
    store.workloads.listConflictResolutions('2026-09-21T10:06:00.000Z').map(({ failedStarts, detail }) => ({ failedStarts, detail })),
    [{ failedStarts: 2, detail: 'second' }],
  );
});

test('given a live conflict resolution of the pull request, when a pre-harness failure is recorded, then nothing is recorded over it', () => {
  const store = Store.open(':memory:');
  const live = store.workloads.startConflictResolution(CONFLICTING_PULL_REQUEST, [], 'run-01', '2026-09-21T10:00:00.000Z', 10, PAIR);
  assert.ok('started' in live);

  store.workloads.recordConflictResolutionStartFailure(CONFLICTING_PULL_REQUEST, 'boom', '2026-09-21T10:00:30.000Z');

  assert.deepEqual(store.workloads.listConflictResolutions('2026-09-21T10:00:40.000Z').map(({ state }) => state), ['running']);
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
    store.workloads.listConflictResolutions('2026-09-21T10:01:00.000Z').map(({ runId, reason }) => ({ runId, reason })),
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
  const start = store.workloads.startRevision(REVISED, [], `run-${at}`, at, Number.POSITIVE_INFINITY);
  assert.ok('started' in start);
  return { id: start.started, after: start.after };
};

const failRevisionToStart = (store: Store, at: string, detail: string): void => {
  store.workloads.failRevisionStart(startedRevision(store, at).id, detail, at);
};

test('given a revision that fails before its harness starts, when revisions are listed, then it reads as a failed start with no run, its reason and its detail', () => {
  const store = Store.open(':memory:');

  failRevisionToStart(store, '2026-09-21T10:00:00.000Z', 'clone failed');

  assert.deepEqual(
    store.workloads.listRevisions('2026-09-21T10:01:00.000Z').map(({ runId, state, reason, detail, failedStarts }) => ({ runId, state, reason, detail, failedStarts })),
    [{ runId: null, state: 'failed', reason: 'not-started', detail: 'clone failed', failedStarts: 1 }],
  );
  assert.equal(store.workloads.liveWorkloads('2026-09-21T10:01:00.000Z'), 0);
});

test('given a revision whose latest record is a failed start, when it fails to start again, then one record is kept with the count raised and the latest detail', () => {
  const store = Store.open(':memory:');
  failRevisionToStart(store, '2026-09-21T10:00:00.000Z', 'first');

  failRevisionToStart(store, '2026-09-21T10:05:00.000Z', 'second');

  assert.deepEqual(
    store.workloads.listRevisions('2026-09-21T10:06:00.000Z').map(({ failedStarts, detail, endedAt }) => ({ failedStarts, detail, endedAt })),
    [{ failedStarts: 2, detail: 'second', endedAt: '2026-09-21T10:05:00.000Z' }],
  );
});

test('given a pull request with no revision started, when its pre-harness step fails twice, then one failed start with no run is kept with the count', () => {
  const store = Store.open(':memory:');

  store.workloads.recordRevisionStartFailure(REVISED, 'first', '2026-09-21T10:00:00.000Z');
  store.workloads.recordRevisionStartFailure(REVISED, 'second', '2026-09-21T10:05:00.000Z');

  assert.deepEqual(
    store.workloads.listRevisions('2026-09-21T10:06:00.000Z').map(({ runId, state, reason, detail, failedStarts }) => ({ runId, state, reason, detail, failedStarts })),
    [{ runId: null, state: 'failed', reason: 'not-started', detail: 'second', failedStarts: 2 }],
  );
});

test('given a live revision of the pull request, when a pre-harness failure is recorded, then nothing is recorded over it', () => {
  const store = Store.open(':memory:');
  startedRevision(store, '2026-09-21T10:00:00.000Z');

  store.workloads.recordRevisionStartFailure(REVISED, 'boom', '2026-09-21T10:00:30.000Z');

  assert.deepEqual(store.workloads.listRevisions('2026-09-21T10:00:40.000Z').map(({ state }) => state), ['running']);
});

test('given a revision that ran and failed, when the next one fails to start, then the failed start is its own record with a count of one', () => {
  const store = Store.open(':memory:');
  store.workloads.endRevision(startedRevision(store, '2026-09-21T10:00:00.000Z').id, 'failed', '2026-09-21T10:05:00.000Z', { reason: 'crashed', detail: null });

  failRevisionToStart(store, '2026-09-21T10:10:00.000Z', 'clone failed');

  assert.deepEqual(
    store.workloads.listRevisions('2026-09-21T10:11:00.000Z').map(({ reason, failedStarts }) => ({ reason, failedStarts })),
    [{ reason: 'crashed', failedStarts: null }, { reason: 'not-started', failedStarts: 1 }],
  );
});

test('given a revision whose latest record is a failed start and feedback the timer already saw, when the timer checks, then the pull request is due again', () => {
  const store = Store.open(':memory:');
  store.workloads.endRevision(startedRevision(store, '2026-09-21T10:00:00.000Z').id, 'done', '2026-09-21T10:01:00.000Z');
  store.workloads.recordWatchedPullRequests('forge', [watched('2026-09-21T10:05:00.000Z')]);
  failRevisionToStart(store, '2026-09-21T10:10:00.000Z', 'clone failed');
  store.workloads.recordWatchedPullRequests('forge', [watched('2026-09-21T10:05:00.000Z')]);

  assert.deepEqual(store.workloads.feedbackDue('2026-09-21T10:11:00.000Z', 600), [REVISED]);
});

test('given a failed start of a pull request that is no longer watched, when the timer checks, then it is not due', () => {
  const store = Store.open(':memory:');
  store.workloads.recordWatchedPullRequests('forge', [watched('2026-09-21T10:05:00.000Z')]);
  failRevisionToStart(store, '2026-09-21T10:10:00.000Z', 'clone failed');
  store.workloads.recordWatchedPullRequests('forge', []);

  assert.deepEqual(store.workloads.feedbackDue('2026-09-21T10:11:00.000Z', 600), []);
});

test('given a failed start that a later revision ran past, when the timer checks, then it is not due until newer feedback arrives', () => {
  const store = Store.open(':memory:');
  store.workloads.recordWatchedPullRequests('forge', [watched('2026-09-21T10:05:00.000Z')]);
  failRevisionToStart(store, '2026-09-21T10:10:00.000Z', 'clone failed');
  store.workloads.endRevision(startedRevision(store, '2026-09-21T10:20:00.000Z').id, 'done', '2026-09-21T10:21:00.000Z');
  store.workloads.recordWatchedPullRequests('forge', [watched('2026-09-21T10:05:00.000Z')]);

  assert.deepEqual(store.workloads.feedbackDue('2026-09-21T11:00:00.000Z', 600), []);
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
    store.workloads.listRevisions('2026-09-21T10:01:00.000Z').map(({ runId, reason }) => ({ runId, reason })),
    [{ runId: 'run-old', reason: 'crashed' }, { runId: null, reason: 'not-started' }],
  );
});

for (const state of ['failed', 'exceeded', 'interrupted'] as const) {
  test(`given a revision that ended ${state}, when the next revision starts, then its window begins where the failed one's began`, () => {
    const store = Store.open(':memory:');
    store.workloads.endRevision(startedRevision(store, '2026-09-21T10:00:00.000Z').id, 'done', '2026-09-21T10:01:00.000Z');
    const failed = startedRevision(store, '2026-09-21T10:10:00.000Z');
    store.workloads.endRevision(failed.id, 'failed', '2026-09-21T10:11:00.000Z', state === 'failed' ? undefined : { reason: state, detail: null });

    assert.equal(startedRevision(store, '2026-09-21T10:20:00.000Z').after, '2026-09-21T10:00:00.000Z');
  });
}

test('given a revision that ended ok, when the next revision starts, then its window begins where the ok one began', () => {
  const store = Store.open(':memory:');
  store.workloads.endRevision(startedRevision(store, '2026-09-21T10:00:00.000Z').id, 'done', '2026-09-21T10:01:00.000Z');

  assert.equal(startedRevision(store, '2026-09-21T10:10:00.000Z').after, '2026-09-21T10:00:00.000Z');
});

test('given a first revision that ended in error, when the next revision starts, then its window has no beginning', () => {
  const store = Store.open(':memory:');
  store.workloads.endRevision(startedRevision(store, '2026-09-21T10:00:00.000Z').id, 'failed', '2026-09-21T10:01:00.000Z');

  assert.equal(startedRevision(store, '2026-09-21T10:10:00.000Z').after, null);
});

test('given a revision that ended error over feedback the timer saw, when the timer checks later, then the pull request is not due until newer feedback arrives', () => {
  const store = Store.open(':memory:');
  store.workloads.endRevision(startedRevision(store, '2026-09-21T10:00:00.000Z').id, 'done', '2026-09-21T10:01:00.000Z');
  store.workloads.recordWatchedPullRequests('forge', [watched('2026-09-21T10:05:00.000Z')]);
  store.workloads.endRevision(startedRevision(store, '2026-09-21T10:10:00.000Z').id, 'failed', '2026-09-21T10:11:00.000Z');

  store.workloads.recordWatchedPullRequests('forge', [watched('2026-09-21T10:05:00.000Z')]);
  assert.deepEqual(store.workloads.feedbackDue('2026-09-21T11:00:00.000Z', 600), []);

  store.workloads.recordWatchedPullRequests('forge', [watched('2026-09-21T10:30:00.000Z')]);
  assert.deepEqual(store.workloads.feedbackDue('2026-09-21T11:00:00.000Z', 600), [REVISED]);
});

test('given a revision that ended error and then new feedback, when the next revision starts, then its window begins before the failed revision so it holds both', () => {
  const store = Store.open(':memory:');
  store.workloads.endRevision(startedRevision(store, '2026-09-21T10:00:00.000Z').id, 'done', '2026-09-21T10:01:00.000Z');
  store.workloads.endRevision(startedRevision(store, '2026-09-21T10:10:00.000Z').id, 'failed', '2026-09-21T10:11:00.000Z');
  store.workloads.recordWatchedPullRequests('forge', [watched('2026-09-21T10:30:00.000Z')]);

  assert.equal(startedRevision(store, '2026-09-21T10:40:00.000Z').after, '2026-09-21T10:00:00.000Z');
});

test('given a revision left running with a stale heartbeat, when a new revision starts, then the stale one is interrupted and the new window begins where the stale one began', () => {
  const store = Store.open(':memory:');
  store.workloads.endRevision(startedRevision(store, '2026-09-21T10:00:00.000Z').id, 'done', '2026-09-21T10:01:00.000Z');
  const stale = startedRevision(store, '2026-09-21T10:10:00.000Z');

  const next = startedRevision(store, '2026-09-21T11:00:00.000Z');

  assert.equal(next.after, '2026-09-21T10:00:00.000Z');
  assert.equal(store.workloads.listRevisions('2026-09-21T11:00:00.000Z').find(({ id }) => id === stale.id)?.reason, 'interrupted');
});

const pull = { repository: 'forge', number: 7, url: 'https://github.com/rameezk/forge/pull/7' };

const watch = (store: Store, closes: number[] = [10]): void => {
  store.workloads.recordWatchedPullRequests('forge', [
    {
      number: 7,
      url: pull.url,
      closes,
      newestFeedbackAt: null,
      mergeable: 'MERGEABLE',
      headSha: 'head-7',
      draft: false,
      defaultSha: 'main0',
    },
  ]);
};

const dueNumbers = (store: Store, now: string): number[] =>
  store.grades.gradingDue(['forge'], now).map(({ number }) => number);

test('given a pull request with a live revision, when a conflict resolution or another revision tries to start on it, then each start is refused', () => {
  const store = Store.open(':memory:');
  const at = '2026-10-01T10:00:00.000Z';
  const later = '2026-10-01T10:00:10.000Z';
  const revision = store.workloads.startRevision(pull, [10], 'run-rev', at, 5);
  assert.ok('started' in revision);

  assert.deepEqual(store.workloads.startRevision(pull, [10], 'run-rev-2', later, 5), { refused: 'revising' });
  assert.deepEqual(
    store.workloads.startConflictResolution(pull, [10], 'run-cr', later, 5, { headSha: 'a', defaultSha: 'b' }),
    { refused: 'revising' },
  );
  store.close();
});

test('given a pull request with a live conflict resolution, when a revision tries to start on it, then the start is refused as resolving', () => {
  const store = Store.open(':memory:');
  const at = '2026-10-01T10:00:00.000Z';
  const started = store.workloads.startConflictResolution(pull, [10], 'run-cr', at, 5, { headSha: 'a', defaultSha: 'b' });
  assert.ok('started' in started);

  assert.deepEqual(store.workloads.startRevision(pull, [10], 'run-rev', '2026-10-01T10:00:10.000Z', 5), {
    refused: 'resolving',
  });
  store.close();
});

test('given a watched head awaiting grading, when a revision, a conflict resolution or the opening dispatch is live, then the head is not due until it ends', () => {
  const at = '2026-10-01T10:00:00.000Z';
  const during = '2026-10-01T10:00:10.000Z';
  const after = '2026-10-01T10:00:20.000Z';

  const revising = Store.open(':memory:');
  watch(revising);
  assert.deepEqual(dueNumbers(revising, at), [7]);
  const revision = revising.workloads.startRevision(pull, [10], 'run-rev', at, 5);
  assert.ok('started' in revision);
  assert.deepEqual(dueNumbers(revising, during), []);
  revising.workloads.endRevision(revision.started, 'done', after);
  assert.deepEqual(dueNumbers(revising, after), [7]);

  const resolving = Store.open(':memory:');
  watch(resolving);
  const resolution = resolving.workloads.startConflictResolution(pull, [10], 'run-cr', at, 5, { headSha: 'a', defaultSha: 'b' });
  assert.ok('started' in resolution);
  assert.deepEqual(dueNumbers(resolving, during), []);
  resolving.workloads.endConflictResolution(resolution.started, 'done', after);
  assert.deepEqual(dueNumbers(resolving, after), [7]);

  const dispatching = Store.open(':memory:');
  watch(dispatching);
  const dispatch = dispatching.workloads.startDispatch(
    { repository: 'forge', number: 10, url: 'https://github.com/rameezk/forge/issues/10' },
    'run-dispatch',
    at,
    5,
    null,
  );
  assert.ok('started' in dispatch);
  assert.deepEqual(dueNumbers(dispatching, during), []);
  dispatching.workloads.endDispatch(dispatch.started, { state: 'failed', reason: 'no-pull-request', detail: null }, after);
  assert.deepEqual(dueNumbers(dispatching, after), [7]);
});

test('given the store, when its public interface is inspected, then no dispatch, revision, conflict resolution, feedback watch or attempt method remains on it', () => {
  const store = Store.open(':memory:');
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(store));
  const moved = methods.filter((name) =>
    /dispatch|revision|conflictResolution|watched|feedbackDue|feedbackCursors|conflictsDue|closesByPullRequest|attempts$|attemptedTickets|liveWorkloads|reviewSlotsTaken|pullRequest(s|Of|Workload)/i.test(name) &&
    !/grading|urgency|risk|graded|heldPull|sampledPull|openGraded/i.test(name),
  );
  assert.deepEqual(moved, []);
  store.close();
});

test('given feedback watches of a repository that is no longer declared, when the watches are pruned, then only the declared repository keeps its watch', () => {
  const store = Store.open(':memory:');
  for (const repository of ['forge', 'gone']) {
    store.workloads.recordWatchedPullRequests(repository, [
      { number: 7, url: pull.url, closes: [10], newestFeedbackAt: null, mergeable: 'MERGEABLE', headSha: 'h', draft: false, defaultSha: 'm' },
    ]);
  }
  store.pruneFrontier(['forge']);
  assert.deepEqual([...store.workloads.closesByPullRequest().keys()], ['forge#7']);
  store.close();
});
