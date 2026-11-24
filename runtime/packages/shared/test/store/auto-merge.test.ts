import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/index.ts';
import type { RiskGrade } from '../../src/index.ts';

const watched = (store: Store, number: number, headSha: string): void => {
  store.workloads.recordWatchedPullRequests('forge', [
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

const grade = (number: number, headSha: string): RiskGrade => ({
  repository: 'forge',
  number,
  headSha,
  fingerprint: 'm:abc',
  model: 'm',
  probabilities: { trivial: 0.1, low: 0.7, moderate: 0.15, high: 0.05 },
  score: 0.4,
  confidence: 0.9,
  level: 'low',
  uncertain: false,
  costUsd: 0.01,
  gradedAt: '2026-10-01T10:00:00.000Z',
});

test('given a candidate held back by a gate, when its verdict is recorded, then the dashboard reads the failing gate', () => {
  const store = Store.open(':memory:');
  watched(store, 7, 'head-7');
  store.recordRiskGrade(grade(7, 'head-7'));
  const gates = [{ key: 'draft' as const, detail: 'it is a draft' }];

  store.autoMerge.recordAutoMergeVerdict('forge', 7, 'head-7', {
    verdict: { kind: 'waits', gates },
    conclusion: 'neutral',
    checkRunId: 3,
  });

  assert.deepEqual(store.autoMerge.currentFailingGates(), [{ repository: 'forge', number: 7, gates }]);
  assert.deepEqual(store.autoMerge.autoMergeVerdict('forge', 7, 'head-7')?.checkRunId, 3);
});

test('given holds on several pull requests, when only some are kept, then the rest are released', () => {
  const store = Store.open(':memory:');
  store.autoMerge.recordHold('forge', 1, true);
  store.autoMerge.recordHold('forge', 2, true);
  store.autoMerge.recordHold('forge', 3, true);

  store.autoMerge.keepHolds('forge', [2]);

  assert.deepEqual(store.autoMerge.heldPullRequests().map(({ repository, number }) => ({ repository, number })), [{ repository: 'forge', number: 2 }]);
  store.autoMerge.recordHold('forge', 2, false);
  assert.deepEqual(store.autoMerge.heldPullRequests(), []);
});

test('given a sample drawn for a pull request, when it is announced and counted, then the counts include it', () => {
  const store = Store.open(':memory:');
  store.autoMerge.recordSample('forge', 4, true, '2026-10-01T10:00:00.000Z');
  store.autoMerge.recordSample('forge', 5, false, '2026-10-01T10:00:00.000Z');
  store.autoMerge.markSampleAnnounced('forge', 4);

  assert.deepEqual(store.autoMerge.sampledPullRequests().map(({ repository, number }) => ({ repository, number })), [{ repository: 'forge', number: 4 }]);
  assert.deepEqual(store.autoMerge.autoMergeCounts({}), { autoMerged: 0, sampled: 1 });
});

test('given an open graded pull request, when auto-merge starts and is cleared, then the grade settles as merged and not auto-merged', () => {
  const store = Store.open(':memory:');
  watched(store, 7, 'head-7');
  store.recordRiskGrade(grade(7, 'head-7'));
  const pullRequest = { repository: 'forge', number: 7, headSha: 'head-7' };

  assert.equal(store.autoMerge.openGradedPullRequests(['forge']).length, 1);
  assert.deepEqual(store.autoMerge.openGradedPullRequests(['other']), []);
  store.autoMerge.markAutoMergeStarted(pullRequest, '2026-10-01T10:01:00.000Z');
  store.autoMerge.clearAutoMergeStarted(pullRequest);
  store.settleRiskGrade(pullRequest, 'merged', '2026-10-01T10:02:00.000Z');

  assert.equal(store.listRiskGrades({ fingerprint: 'm:abc' })[0]?.outcome, 'merged');
});

test('given a pull request with no workload, when a revision starts on it, then a workload is running until its heartbeat goes stale', () => {
  const store = Store.open(':memory:');
  const pullRequest = { repository: 'forge', number: 7, url: 'https://github.com/rameezk/forge/pull/7' };
  const now = '2026-10-01T10:00:00.000Z';
  assert.equal(store.autoMerge.workloadRunning('forge', 7, now), false);

  store.workloads.startRevision(pullRequest, [], 'run-1', now, 5);

  assert.equal(store.autoMerge.workloadRunning('forge', 7, now), true);
  assert.equal(store.autoMerge.workloadRunning('forge', 8, now), false);
  assert.equal(store.autoMerge.workloadRunning('forge', 7, '2026-10-01T12:00:00.000Z'), false);
});
