import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/index.ts';
import type { UrgencyGrade, UrgencyAttempt, Ticket } from '../../src/index.ts';

const ticket = (number: number, version: string): Ticket => ({
  number,
  title: `Ticket ${number}`,
  url: `https://github.com/rameezk/forge/issues/${number}`,
  parent: null,
  createdAt: '2026-09-28T10:00:00Z',
  forgeReady: true,
  blocked: false,
  forHuman: false,
  blockedBy: [],
  version,
});

const withFrontier = (tickets: Ticket[]): Store => {
  const store = Store.open(':memory:');
  store.replaceFrontier({
    repository: 'forge',
    github: 'rameezk/forge',
    polledAt: '2026-09-29T08:15:00.000Z',
    tickets,
    closed: [],
    requests: [],
  });
  return store;
};

const grade = (number: number, version: string, overrides: Partial<UrgencyGrade> = {}): UrgencyGrade => ({
  repository: 'forge',
  number,
  version,
  fingerprint: 'fingerprint',
  model: 'typesafe/jev-1.13',
  probabilities: { critical: 0.1, high: 0.7, normal: 0.1, low: 0.1 },
  score: 0.5,
  confidence: 0.7,
  level: 'high',
  uncertain: false,
  costUsd: 0.01,
  gradedAt: '2026-10-02T09:00:00.000Z',
  ...overrides,
});

const attempt = (number: number, version: string, overrides: Partial<UrgencyAttempt> = {}): UrgencyAttempt => ({
  repository: 'forge',
  number,
  version,
  attemptedAt: '2026-10-02T10:00:00.000Z',
  category: 'declined',
  message: 'Jev declined to answer',
  ...overrides,
});

test('given an urgency attempt recorded through urgency, when the dashboard reads current urgency attempts, then the attempt appears', () => {
  const store = withFrontier([ticket(5, 'v5')]);
  store.urgency.recordAttempt(attempt(5, 'v5'));

  assert.deepEqual(store.urgency.currentAttempts(), [attempt(5, 'v5')]);
});

test('given an attempt for an earlier version or a version since graded, when current attempts are read, then it is not listed', () => {
  const store = withFrontier([ticket(5, 'v5b'), ticket(6, 'v6')]);
  store.urgency.recordAttempt(attempt(5, 'v5a'));
  store.urgency.recordAttempt(attempt(6, 'v6'));
  store.urgency.recordGrade(grade(6, 'v6'));

  assert.deepEqual(store.urgency.currentAttempts(), []);
});

test('given a ticket regraded after an edit, when the current grade is read, then the earlier level stays until the new version is graded', () => {
  const store = withFrontier([ticket(5, 'v5b')]);
  store.urgency.recordGrade(grade(5, 'v5a'));

  assert.equal(store.urgency.currentGrade('forge', 5)?.level, 'high');
  store.urgency.recordGrade(grade(5, 'v5b', { level: 'low' }));
  assert.equal(store.urgency.currentGrade('forge', 5)?.level, 'low');
  assert.deepEqual(
    store.urgency.currentGrades().map(({ number, version }) => [number, version]),
    [[5, 'v5b']],
  );
});

test('given ungraded tickets and a retried failure, when urgency due is read, then the failure holds the ticket off until its backoff passes', () => {
  const store = withFrontier([ticket(5, 'v5'), ticket(6, 'v6')]);
  store.urgency.recordAttempt(attempt(5, 'v5', { category: 'temporary' }));
  const numbers = (now: string): number[] => store.urgency.due(['forge'], now).map(({ number }) => number);

  assert.deepEqual(numbers('2026-10-02T10:00:10.000Z'), [6]);
  assert.deepEqual(numbers('2026-10-02T10:01:00.000Z'), [5, 6]);
  store.urgency.recordGrade(grade(6, 'v6'));
  assert.deepEqual(numbers('2026-10-02T10:01:00.000Z'), [5]);
});

test('given a grade whose labels are not applied, when labels are marked applied, then it stops awaiting labels', () => {
  const store = withFrontier([ticket(5, 'v5')]);
  store.urgency.recordGrade(grade(5, 'v5'));

  assert.equal(store.urgency.gradesAwaitingLabels(['forge']).length, 1);
  store.urgency.markLabelsApplied({ repository: 'forge', number: 5, version: 'v5' });
  assert.deepEqual(store.urgency.gradesAwaitingLabels(['forge']), []);
});

test('given the store, when its interface is inspected, then no urgency method remains on it', () => {
  const store = Store.open(':memory:');

  assert.deepEqual(
    Object.getOwnPropertyNames(Object.getPrototypeOf(store)).filter((name) => /urgency/i.test(name)),
    [],
  );
});
