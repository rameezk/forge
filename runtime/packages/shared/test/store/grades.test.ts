import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../src/index.ts';
import type { GradingAttempt, GradingFailure } from '../../src/index.ts';
const watchedHead = (store: Store, number: number, headSha: string): void => {
  store.recordWatchedPullRequests('forge', [
    {
      number,
      url: `https://github.com/rameezk/forge/pull/${number}`,
      closes: [10],
      newestFeedbackAt: null,
      mergeable: 'MERGEABLE',
      headSha,
      draft: false,
      defaultSha: 'main0',
    },
  ]);
};

const failure = (
  category: GradingFailure,
  attemptedAt: string,
  overrides: Partial<GradingAttempt> = {},
): GradingAttempt => ({
  repository: 'forge',
  number: 7,
  headSha: 'head-7',
  attemptedAt,
  category,
  message: `${category} message`,
  ...overrides,
});

const dueAt = (store: Store, now: string): number[] =>
  store.gradingDue(['forge'], now).map(({ number }) => number);

test('given temporary, setup and bug failures, when time passes, then the head is due again on a backoff that doubles up to an hour', () => {
  for (const category of ['temporary', 'setup', 'bug'] as const) {
    const store = Store.open(':memory:');
    watchedHead(store, 7, 'head-7');
    assert.deepEqual(dueAt(store, '2026-10-01T10:00:00.000Z'), [7]);

    store.recordGradingAttempt(failure(category, '2026-10-01T10:00:00.000Z'));
    assert.deepEqual(dueAt(store, '2026-10-01T10:00:01.000Z'), [], category);
    assert.deepEqual(dueAt(store, '2026-10-01T10:00:30.000Z'), [7], category);

    store.recordGradingAttempt(failure(category, '2026-10-01T10:00:30.000Z'));
    assert.deepEqual(dueAt(store, '2026-10-01T10:01:00.000Z'), [], category);
    assert.deepEqual(dueAt(store, '2026-10-01T10:01:30.000Z'), [7], category);

    for (let again = 0; again < 10; again += 1) {
      store.recordGradingAttempt(failure(category, `2026-10-01T11:00:0${again}.000Z`));
    }
    assert.deepEqual(dueAt(store, '2026-10-01T11:59:00.000Z'), [], category);
    assert.deepEqual(dueAt(store, '2026-10-01T12:00:10.000Z'), [7], category);
    store.close();
  }
});

test('given a declined or too large failure, when time passes, then that head is never due again but a new head is', () => {
  for (const category of ['declined', 'too-large'] as const) {
    const store = Store.open(':memory:');
    watchedHead(store, 7, 'head-7');
    store.recordGradingAttempt(failure(category, '2026-10-01T10:00:00.000Z'));
    assert.deepEqual(dueAt(store, '2027-10-01T10:00:00.000Z'), [], category);

    watchedHead(store, 7, 'head-8');
    assert.deepEqual(dueAt(store, '2026-10-01T10:00:01.000Z'), [7], category);
    store.close();
  }
});

test('given a failing attempt on a head, when the dashboard reads the store, then the head shows its latest attempt and the status line the latest failure', () => {
  const store = Store.open(':memory:');
  watchedHead(store, 7, 'head-7');
  assert.deepEqual(store.gradingStatus(), { lastSucceededAt: null, failingSince: null, failure: null });

  store.recordGradingAttempt(failure('temporary', '2026-10-01T10:00:00.000Z', { message: 'first' }));
  store.recordGradingAttempt(failure('setup', '2026-10-01T10:01:00.000Z', { message: 'second' }));

  assert.deepEqual(
    store.currentGradingAttempts().map(({ number, category, message }) => ({ number, category, message })),
    [{ number: 7, category: 'setup', message: 'second' }],
  );
  assert.deepEqual(store.gradingStatus().failure, failure('setup', '2026-10-01T10:01:00.000Z', { message: 'second' }));
  store.close();
});

test('given a failing head and a later grade of another head, when the dashboard reads the store, then grading is still failing until the failing head is graded', () => {
  const store = Store.open(':memory:');
  watchedHead(store, 7, 'head-7');
  watchedHead(store, 8, 'head-8');
  const grade = (number: number, gradedAt: string) => ({
    repository: 'forge',
    number,
    headSha: `head-${number}`,
    fingerprint: 'm:abc',
    model: 'm',
    probabilities: { trivial: 0.1, low: 0.7, moderate: 0.15, high: 0.05 },
    score: 0.4,
    confidence: 0.9,
    level: 'low' as const,
    uncertain: false,
    costUsd: 0.01,
    gradedAt,
  });
  assert.deepEqual(store.gradingStatus(), { lastSucceededAt: null, failingSince: null, failure: null });
  store.recordGradingAttempt(failure('setup', '2026-10-01T10:00:00.000Z'));
  store.recordRiskGrade(grade(8, '2026-10-01T10:05:00.000Z'));

  assert.equal(store.gradingStatus().lastSucceededAt, '2026-10-01T10:05:00.000Z');
  assert.equal(store.gradingStatus().failure?.category, 'setup');

  store.recordRiskGrade(grade(7, '2026-10-01T10:06:00.000Z'));
  assert.deepEqual(store.gradingStatus(), { lastSucceededAt: '2026-10-01T10:06:00.000Z', failingSince: null, failure: null });
  store.close();
});

test('given a setup failure and a newer temporary failure on other heads, when the dashboard reads the store, then the status line reports the setup failure', () => {
  const store = Store.open(':memory:');
  watchedHead(store, 7, 'head-7');
  watchedHead(store, 8, 'head-8');
  store.recordGradingAttempt(failure('setup', '2026-10-01T10:00:00.000Z'));
  store.recordGradingAttempt(failure('temporary', '2026-10-01T10:05:00.000Z', { number: 8, headSha: 'head-8' }));
  assert.equal(store.gradingStatus().failure?.category, 'setup');
  store.close();
});

test('given a setup, a bug and a newer temporary failure on three heads, when the dashboard reads the store, then the status line reports the setup failure and without it the bug failure', () => {
  const store = Store.open(':memory:');
  for (const number of [7, 8, 9]) watchedHead(store, number, `head-${number}`);
  store.recordGradingAttempt(failure('temporary', '2026-10-01T10:05:00.000Z', { number: 9, headSha: 'head-9' }));
  store.recordGradingAttempt(failure('bug', '2026-10-01T10:04:00.000Z', { number: 8, headSha: 'head-8' }));
  assert.equal(store.gradingStatus().failure?.category, 'bug');
  store.recordGradingAttempt(failure('setup', '2026-10-01T10:00:00.000Z'));
  assert.equal(store.gradingStatus().failure?.category, 'setup');
  store.close();
});

test('given grading has never succeeded and failed over several attempts, when the dashboard reads the store, then it is failing since the first failed attempt, and a later grade of another head does not move that start', () => {
  const store = Store.open(':memory:');
  watchedHead(store, 7, 'head-7');
  watchedHead(store, 8, 'head-8');
  store.recordGradingAttempt(failure('too-large', '2026-10-01T08:00:00.000Z', { number: 8, headSha: 'head-8' }));
  store.recordGradingAttempt(failure('temporary', '2026-10-01T09:00:00.000Z'));
  store.recordGradingAttempt(failure('temporary', '2026-10-01T10:00:00.000Z'));
  assert.equal(store.gradingStatus().failingSince, '2026-10-01T09:00:00.000Z');
  store.recordRiskGrade({ repository: 'forge', number: 8, headSha: 'head-8', fingerprint: 'm:abc', model: 'm', probabilities: { trivial: 0.1, low: 0.7, moderate: 0.15, high: 0.05 }, score: 0.4, confidence: 0.9, level: 'low', uncertain: false, costUsd: 0.01, gradedAt: '2026-10-01T09:30:00.000Z' });
  assert.equal(store.gradingStatus().failingSince, '2026-10-01T09:00:00.000Z');
  store.close();
});

test('given a declined or too large head only, when the dashboard reads the store, then grading is not reported as failing', () => {
  const store = Store.open(':memory:');
  watchedHead(store, 7, 'head-7');
  store.recordGradingAttempt(failure('declined', '2026-10-01T10:00:00.000Z'));
  assert.equal(store.gradingStatus().failure, null);
  store.close();
});

test('given grading is failing for every pull request, when a dispatch is counted, then the review slots and live workloads are what they were', () => {
  const store = Store.open(':memory:');
  watchedHead(store, 7, 'head-7');
  const now = '2026-10-01T10:00:00.000Z';
  const before = JSON.stringify([store.reviewSlotsTaken(now), store.liveWorkloads(now)]);
  store.recordGradingAttempt(failure('setup', now));
  assert.equal(JSON.stringify([store.reviewSlotsTaken(now), store.liveWorkloads(now)]), before);
  store.close();
});

test('given an attempt that repeats the previous one, when it is recorded, then only the first is awaiting a check run until it is marked posted', () => {
  const store = Store.open(':memory:');
  watchedHead(store, 7, 'head-7');
  store.recordGradingAttempt(failure('temporary', '2026-10-01T10:00:00.000Z'));
  assert.equal(store.attemptsAwaitingCheck(['forge']).length, 1);
  store.markAttemptCheckPosted(failure('temporary', '2026-10-01T10:00:00.000Z'));
  store.recordGradingAttempt(failure('temporary', '2026-10-01T10:00:30.000Z'));
  assert.equal(store.attemptsAwaitingCheck(['forge']).length, 0);
  store.recordGradingAttempt(failure('setup', '2026-10-01T10:01:30.000Z'));
  assert.equal(store.attemptsAwaitingCheck(['forge']).length, 1);
  store.close();
});

test('given a store whose superseded grades predate supersede causes, when it is opened, then they read unknown and merged grades carry no cause', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'forge-store-')), 'forge.db');
  const grade = (headSha: string) => ({
    repository: 'forge',
    number: 7,
    headSha,
    fingerprint: 'model:aaaa',
    model: 'model',
    probabilities: { trivial: 0.1, low: 0.7, moderate: 0.1, high: 0.1 },
    score: 1,
    confidence: 0.9,
    level: 'low' as const,
    uncertain: false,
    costUsd: 0.01,
    gradedAt: '2026-09-21T10:00:00.000Z',
  });
  const first = Store.open(path);
  first.recordRiskGrade(grade('one'));
  first.recordRiskGrade(grade('two'));
  first.settleRiskGrade({ repository: 'forge', number: 7, headSha: 'one' }, 'superseded', '2026-09-21T11:00:00.000Z', 'two');
  first.settleRiskGrade({ repository: 'forge', number: 7, headSha: 'two' }, 'merged', '2026-09-21T12:00:00.000Z');
  first.close();
  const old = new DatabaseSync(path);
  old.exec(`
    ALTER TABLE risk_grades DROP COLUMN supersede_cause;
    ALTER TABLE revisions DROP COLUMN pushed_sha;
    ALTER TABLE conflict_resolutions DROP COLUMN pushed_sha;
  `);
  old.close();

  const store = Store.open(path);
  try {
    assert.equal(store.riskGrade('forge', 7, 'one')?.supersedeCause, 'unknown');
    assert.equal(store.riskGrade('forge', 7, 'two')?.supersedeCause, null);
  } finally {
    store.close();
  }
});

test('given a store holding a grade settled as other by a conflict resolution push and a grade settled as unknown, when it is opened, then the first reads conflict-resolution and the second stays unknown', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'forge-store-')), 'forge.db');
  const grade = (number: number, headSha: string, gradedAt: string) => ({
    repository: 'forge',
    number,
    headSha,
    fingerprint: 'model:aaaa',
    model: 'model',
    probabilities: { trivial: 0.1, low: 0.7, moderate: 0.1, high: 0.1 },
    score: 1,
    confidence: 0.9,
    level: 'low' as const,
    uncertain: false,
    costUsd: 0.01,
    gradedAt,
  });
  const first = Store.open(path);
  first.recordRiskGrade(grade(7, 'one', '2026-09-21T10:00:00.000Z'));
  first.recordRiskGrade(grade(7, 'two', '2026-09-21T11:00:00.000Z'));
  first.recordRiskGrade(grade(8, 'three', '2026-09-21T10:00:00.000Z'));
  first.recordRiskGrade(grade(8, 'four', '2026-09-21T11:00:00.000Z'));
  first.settleRiskGrade({ repository: 'forge', number: 7, headSha: 'one' }, 'superseded', '2026-09-21T11:30:00.000Z', 'unmatched');
  first.settleRiskGrade({ repository: 'forge', number: 8, headSha: 'three' }, 'superseded', '2026-09-21T11:30:00.000Z');
  const start = first.startConflictResolution(
    { repository: 'forge', number: 7, url: 'https://github.com/rameezk/forge/pull/7' },
    [],
    'run-1',
    '2026-09-21T10:30:00.000Z',
    Number.POSITIVE_INFINITY,
    { headSha: 'one', defaultSha: 'default-1' },
  );
  assert.ok('started' in start);
  first.recordConflictResolutionPush(start.started, 'two');
  first.endConflictResolution(start.started, 'done', '2026-09-21T10:40:00.000Z');
  first.close();
  const old = new DatabaseSync(path);
  old.exec(`UPDATE risk_grades SET supersede_cause = 'unknown' WHERE head_sha = 'three'`);
  old.close();

  const store = Store.open(path);
  try {
    assert.equal(store.riskGrade('forge', 7, 'one')?.supersedeCause, 'conflict-resolution');
    assert.equal(store.riskGrade('forge', 8, 'three')?.supersedeCause, 'unknown');
  } finally {
    store.close();
  }
});

test('given a store whose risk grades table still has the unsettled column, when it is opened, then a grade recorded as unsettled reads back as uncertain', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'forge-store-')), 'forge.db');
  const first = Store.open(path);
  first.recordRiskGrade({
    repository: 'forge',
    number: 7,
    headSha: 'one',
    fingerprint: 'model:aaaa',
    model: 'model',
    probabilities: { trivial: 0.1, low: 0.4, moderate: 0.1, high: 0.4 },
    score: 1,
    confidence: 0.4,
    level: 'low',
    uncertain: true,
    costUsd: 0.01,
    gradedAt: '2026-09-21T10:00:00.000Z',
  });
  first.close();
  const old = new DatabaseSync(path);
  old.exec('ALTER TABLE risk_grades RENAME COLUMN uncertain TO unsettled');
  old.close();

  const store = Store.open(path);
  try {
    assert.equal(store.riskGrade('forge', 7, 'one')?.uncertain, true);
  } finally {
    store.close();
  }
});
