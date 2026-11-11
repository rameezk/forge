import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIAGNOSED_FAILURES,
  parseVerdict,
  Store,
  UNDIAGNOSED_FAILURES,
  type DispatchFailure,
  type RunRecord,
} from '../src/index.ts';

const PR = { repository: 'forge', number: 7, url: 'https://github.com/rameezk/forge/pull/7' };

const aRun = (id: string, overrides: Partial<RunRecord> = {}): RunRecord => ({
  id,
  worker: 'builder',
  harness: 'pi',
  model: 'm',
  reasoningEffort: null,
  startTime: new Date().toISOString(),
  endTime: new Date().toISOString(),
  status: 'success',
  costStatus: 'billed',
  costUsd: 1,
  costEstimated: false,
  unconfirmedEstimateUsd: 0,
  listPrice: null,
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  transcriptRef: `${id}.jsonl`,
  sessionId: null,
  error: null,
  ticket: { repository: 'forge', number: 1, url: 'https://github.com/rameezk/forge/issues/1' },
  aliveAt: null,
  harnessStartTime: null,
  timeoutSeconds: null,
  maxCostUsd: null,
  exceededLimit: null,
  counters: null,
  ...overrides,
});

const failedDispatch = (store: Store, runId: string, reason: DispatchFailure, number = 1): void => {
  const at = new Date().toISOString();
  const start = store.startDispatch(
    { repository: 'forge', number, url: `https://github.com/rameezk/forge/issues/${number}` },
    runId,
    at,
    Number.POSITIVE_INFINITY,
    null,
  );
  assert.ok('started' in start);
  store.endDispatch(start.started, { state: 'failed', reason, detail: null }, at);
};

test('every failure reason sits in exactly one of the diagnosed and undiagnosed lists', () => {
  const overlap = DIAGNOSED_FAILURES.filter((reason) => (UNDIAGNOSED_FAILURES as readonly string[]).includes(reason));
  assert.deepEqual(overlap, []);
});

test('given failed workloads of each kind and reason, when the undiagnosed failures are listed, then only those in scope appear, each once its diagnosis starts', () => {
  const store = Store.open(':memory:');
  failedDispatch(store, 'checks', 'check-failed', 1);
  failedDispatch(store, 'stopped', 'interrupted', 2);
  failedDispatch(store, 'noshell', 'devshell-failed', 3);
  const at = new Date().toISOString();
  const revision = store.startRevision(PR, [], 'revision', at, Number.POSITIVE_INFINITY);
  assert.ok('started' in revision);
  store.endRevision(revision.started, 'failed', at, { reason: 'unanswered', detail: null });
  const resolution = store.startConflictResolution(
    { ...PR, number: 8 },
    [],
    'resolution',
    at,
    Number.POSITIVE_INFINITY,
    { headSha: 'a', defaultSha: 'b' },
  );
  assert.ok('started' in resolution);
  store.endConflictResolution(resolution.started, 'failed', at, { reason: 'still-conflicting', detail: null });

  assert.deepEqual(
    store.undiagnosedFailures().map(({ runId }) => runId).toSorted(),
    ['checks', 'resolution', 'revision'],
  );

  store.startDiagnosis('checks', 'diagnosis-1', at);
  assert.deepEqual(
    store.undiagnosedFailures().map(({ runId }) => runId).toSorted(),
    ['resolution', 'revision'],
  );
});

test('given a failed diagnosis, when the undiagnosed failures are listed, then the failed run is not offered again and the diagnosis is not itself a failure to diagnose', () => {
  const store = Store.open(':memory:');
  failedDispatch(store, 'checks', 'check-failed');
  const at = new Date().toISOString();
  const id = store.startDiagnosis('checks', 'diagnosis-1', at);
  store.endDiagnosis(id, 'failed', at, { detail: 'no diagnosis.json' });
  assert.deepEqual(store.undiagnosedFailures(), []);
  assert.equal(store.diagnosesOf('checks', at)[0]?.state, 'failed');
});

test('given a diagnosis that recorded a verdict, when the failed run is looked up, then it carries the verdict, newest first', () => {
  const store = Store.open(':memory:');
  failedDispatch(store, 'checks', 'check-failed');
  const first = store.startDiagnosis('checks', 'diagnosis-1', '2026-11-01T10:00:00.000Z');
  store.endDiagnosis(first, 'done', '2026-11-01T10:05:00.000Z', {
    verdict: { category: 'skill', evidence: [{ turn: 3, note: 'skipped the skill' }], suggestedFix: 'Fix the skill' },
  });
  const second = store.startDiagnosis('checks', 'diagnosis-2', '2026-11-02T10:00:00.000Z');
  store.endDiagnosis(second, 'failed', '2026-11-02T10:01:00.000Z', { detail: 'missing' });
  const diagnoses = store.diagnosesOf('checks', '2026-11-03T00:00:00.000Z');
  assert.deepEqual(diagnoses.map(({ runId }) => runId), ['diagnosis-2', 'diagnosis-1']);
  assert.equal(diagnoses[1]?.verdict?.category, 'skill');
  assert.equal(store.diagnosisOfRun('diagnosis-1', '2026-11-03T00:00:00.000Z')?.failedRunId, 'checks');
});

test('given a running diagnosis, when workloads are counted, then it holds no concurrency or review slot', () => {
  const store = Store.open(':memory:');
  failedDispatch(store, 'checks', 'check-failed');
  const at = new Date().toISOString();
  store.startDiagnosis('checks', 'diagnosis-1', at);
  assert.equal(store.liveWorkloads(at), 0);
  assert.equal(store.dispatchesInReview(at), 0);
});

test('given diagnosis runs in the store, when insights load with manual workloads included, then no diagnosis cohort or spend is counted', () => {
  const store = Store.open(':memory:');
  store.insertRun(aRun('diagnosis-1', { costUsd: 9 }));
  const at = new Date().toISOString();
  failedDispatch(store, 'checks', 'check-failed');
  store.startDiagnosis('checks', 'diagnosis-1', at);
  const filter = { includeManual: true };
  assert.deepEqual(store.listCohorts(filter), []);
  assert.deepEqual(store.listPoints(filter), []);
  assert.deepEqual(store.listProviderShares(filter), []);
});

test('given a verdict file, when it is parsed, then a valid one yields the verdict and each contract breach is refused', () => {
  const valid = { category: 'skill', evidence: [{ turn: 4, note: 'ignored the skill' }], suggestedFix: 'Reword it' };
  assert.deepEqual(parseVerdict(JSON.stringify(valid)), valid);
  for (const broken of [
    'not json',
    '[]',
    JSON.stringify({ ...valid, category: 'gremlins' }),
    JSON.stringify({ ...valid, evidence: [] }),
    JSON.stringify({ ...valid, evidence: [{ turn: 0, note: 'x' }] }),
    JSON.stringify({ ...valid, evidence: [{ turn: 1 }] }),
    JSON.stringify({ ...valid, suggestedFix: '' }),
  ]) {
    assert.throws(() => parseVerdict(broken), /diagnosis\.json/);
  }
});
