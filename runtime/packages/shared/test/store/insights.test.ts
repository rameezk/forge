import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintHash, Store } from '../../src/index.ts';
import type { ConfigFingerprint, InsightsFilter, RunRecord } from '../../src/index.ts';
import { sampleRun } from './support.ts';

const SONNET: ConfigFingerprint = {
  model: 'anthropic/claude-sonnet-5.5',
  reasoningEffort: 'high',
  harnessArgs: [],
  harnessVersion: '1.0.0',
  promptTemplate: '3fa2c9d1',
  systemPrompt: 's',
  tools: 't',
  skills: 'k',
};

const GLM: ConfigFingerprint = { ...SONNET, model: 'z-ai/glm-5', reasoningEffort: null, promptTemplate: '9b1e77aa' };

const filter: InsightsFilter = { kind: 'all', includeManual: false };

const seedDispatch = (store: Store, id: string, fingerprint: ConfigFingerprint, costUsd: number, number: number): void => {
  const run: RunRecord = {
    ...sampleRun({ id, worker: 'builder', costUsd }),
    ticket: { repository: 'forge', number, url: `https://github.com/rameezk/forge/issues/${number}` },
    startTime: `2026-09-2${number}T10:00:00.000Z`,
    endTime: `2026-09-2${number}T10:10:00.000Z`,
  };
  store.runs.insertRun(run);
  store.runs.recordFingerprint(id, { fingerprint, hash: fingerprintHash(fingerprint), forgeGitSha: null, baseCommit: null });
  store.runs.recordGeneration({
    runId: id,
    generationId: `${id}-gen`,
    subagent: null,
    kind: 'message',
    usage: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    estimatedCostUsd: null,
    createdAt: run.startTime,
  });
  const generation = store.runs.unsettledGenerations().find(({ generationId }) => generationId === `${id}-gen`)!;
  store.runs.recordLookups(
    [{ id: generation.id, billing: { costUsd, usage: null, reasoningTokens: null, provider: 'anthropic', model: null } }],
    run.endTime!,
  );
  const started = store.startDispatch(run.ticket!, id, run.startTime, 100, null);
  assert.ok('started' in started);
  store.endDispatch(
    started.started,
    { state: 'done', pullRequest: { number: 7, url: 'https://github.com/rameezk/forge/pull/7' } },
    run.endTime!,
  );
};

const seeded = (): Store => {
  const store = Store.open(':memory:');
  seedDispatch(store, 'sonnet-1', SONNET, 1, 1);
  seedDispatch(store, 'sonnet-2', SONNET, 3, 2);
  seedDispatch(store, 'glm-1', GLM, 0.5, 3);
  return store;
};

test('given runs across two cohorts, when insights read cohorts, then each cohort aggregates its own runs', () => {
  const cohorts = seeded().insights.listCohorts(filter);
  assert.equal(cohorts.length, 2);
  const byHash = new Map(cohorts.map((cohort) => [cohort.hash, cohort]));
  assert.equal(byHash.get(fingerprintHash(SONNET))?.workloads, 2);
  assert.equal(byHash.get(fingerprintHash(GLM))?.workloads, 1);
});

test('given runs across two cohorts, when insights read points, then one point per priced run is listed oldest first', () => {
  const points = seeded().insights.listPoints(filter);
  assert.deepEqual(points.map(({ runId, costUsd }) => [runId, costUsd]), [['sonnet-1', 1], ['sonnet-2', 3], ['glm-1', 0.5]]);
});

test('given generations billed by a provider, when insights read provider shares, then tokens are summed per cohort', () => {
  const shares = seeded().insights.listProviderShares(filter);
  assert.deepEqual(
    shares.map(({ hash, providers }) => [hash, providers]).sort(([a], [b]) => String(a).localeCompare(String(b))),
    [fingerprintHash(GLM), fingerprintHash(SONNET)]
      .sort()
      .map((hash) => [hash, [{ provider: 'anthropic', tokens: hash === fingerprintHash(SONNET) ? 200 : 100 }]]),
  );
});

test('given finished runs, when insights read options, then the workers and repositories to filter by are listed', () => {
  assert.deepEqual(seeded().insights.options(), { workers: ['builder'], repositories: ['forge'] });
});

test('given the store, when its interface is inspected, then it offers no insight read and insights offers only reads', () => {
  const store = seeded();
  for (const name of ['listCohorts', 'listPoints', 'listProviderShares', 'insightsOptions']) {
    assert.equal(name in store, false, name);
  }
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(store.insights)).filter((name) => name !== 'constructor');
  assert.deepEqual(methods.sort(), ['listCohorts', 'listPoints', 'listProviderShares', 'options']);
});
