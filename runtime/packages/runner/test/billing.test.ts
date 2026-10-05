import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '@forge/shared';
import { settleGenerations, type LookupOutcome } from '../src/index.ts';

const NOW = '2026-09-29T12:00:00.000Z';

const DAY_MS = 24 * 60 * 60 * 1000;

const NO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

const billed = async (costUsd: number): Promise<LookupOutcome> => ({
  outcome: 'billed',
  billing: { costUsd, usage: null, reasoningTokens: null, provider: null, model: null },
});

const endedAgo = (ms: number): string =>
  new Date(Date.parse(NOW) - ms).toISOString();

const BEATING = endedAgo(10_000);

const startedRun = (
  store: Store,
  id: string,
  {
    startTime = endedAgo(DAY_MS + 60_000),
    generatedAt = endedAgo(DAY_MS + 30_000),
    aliveAt = null,
  }: { startTime?: string; generatedAt?: string | null; aliveAt?: string | null } = {},
): void => {
  store.insertRun({
    id,
    worker: 'refiner',
    harness: 'pi',
    model: 'z-ai/glm-5',
    reasoningEffort: null,
    startTime,
    endTime: null,
    status: 'running',
    costStatus: 'pending',
    costUsd: 0,
    costEstimated: false,
    listPrice: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    transcriptRef: `${id}.jsonl`,
    sessionId: null,
    error: null,
    ticket: null,
    aliveAt,
  });
  if (generatedAt !== null) {
    store.recordGeneration({
      runId: id,
      generationId: `gen-${id}`,
      subagent: null,
      usage: NO_USAGE,
      estimatedCostUsd: null,
      createdAt: generatedAt,
    });
  }
};

const finish = (store: Store, id: string, endTime: string): void => {
  store.finalizeRun(id, {
    endTime,
    status: 'success',
    sessionId: null,
    error: null,
  });
};

const finishedRun = (store: Store, id: string, endTime: string): void => {
  startedRun(store, id);
  finish(store, id, endTime);
};

test('given one run that ended just over 24 hours ago and one just under, each with a generation OpenRouter still answers with not found, when the settle step runs, then the older run is unconfirmed and logs the give-up while the newer stays pending', async () => {
  const store = Store.open(':memory:');
  finishedRun(store, 'stale', endedAgo(DAY_MS + 1000));
  finishedRun(store, 'fresh', endedAgo(DAY_MS - 1000));
  const log: string[] = [];

  await settleGenerations({
    store,
    lookUp: async () => ({ outcome: 'temporary', reason: 'HTTP 404' }),
    now: () => NOW,
    log: (line) => log.push(line),
  });

  assert.equal(store.getRun('stale')?.costStatus, 'unconfirmed');
  assert.equal(store.getRun('fresh')?.costStatus, 'pending');
  assert.deepEqual(log.length, 1);
  assert.match(log[0] ?? '', /"gen-stale"/);
  assert.match(log[0] ?? '', /run "stale"/);
  assert.match(log[0] ?? '', /HTTP 404/);
  assert.match(log[0] ?? '', /still unbilled after 24 hours/);
  assert.deepEqual(
    store.listGenerations('fresh').map(({ attempts, lastAttemptAt }) => ({
      attempts,
      lastAttemptAt,
    })),
    [{ attempts: 1, lastAttemptAt: NOW }],
  );
});

test('given a run still running whose generations so far are all billed, when the settle step runs, then the run stays pending with its billed cost so far until it ends, and is billed once it does', async () => {
  const store = Store.open(':memory:');
  startedRun(store, 'live', { generatedAt: endedAgo(60_000), aliveAt: BEATING });

  await settleGenerations({
    store,
    lookUp: async () => billed(0.25),
    now: () => NOW,
    log: () => {},
  });

  assert.equal(store.getRun('live')?.costStatus, 'pending');
  assert.equal(store.getRun('live')?.costUsd, 0.25);
  finish(store, 'live', NOW);
  assert.equal(store.getRun('live')?.costStatus, 'billed');
  assert.equal(store.getRun('live')?.costUsd, 0.25);
});

test('given a run whose runner is still beating but has had no generation for 24 hours, when the settle step runs, then it keeps running with what was billed as unconfirmed, a given-up row records why, the give-up is logged, and a run still within the window stays pending', async () => {
  const store = Store.open(':memory:');
  startedRun(store, 'quiet', { aliveAt: BEATING });
  startedRun(store, 'recent', { aliveAt: BEATING });
  store.recordGeneration({
    runId: 'recent',
    generationId: 'gen-recent-late',
    subagent: null,
    usage: NO_USAGE,
    estimatedCostUsd: null,
    createdAt: endedAgo(DAY_MS - 1000),
  });
  const log: string[] = [];

  await settleGenerations({
    store,
    lookUp: async () => billed(0.25),
    now: () => NOW,
    log: (line) => log.push(line),
  });

  assert.equal(store.getRun('quiet')?.status, 'running');
  assert.equal(store.getRun('quiet')?.costStatus, 'unconfirmed');
  assert.equal(store.getRun('quiet')?.costUsd, 0.25);
  assert.deepEqual(
    store
      .listGenerations('quiet')
      .map(({ generationId, givenUpAt, lastError }) => ({ generationId, givenUpAt, lastError })),
    [
      { generationId: 'gen-quiet', givenUpAt: null, lastError: null },
      {
        generationId: null,
        givenUpAt: NOW,
        lastError: 'run never ended, so later generations may be unrecorded',
      },
    ],
  );
  assert.equal(store.getRun('recent')?.costStatus, 'pending');
  assert.equal(store.getRun('recent')?.costUsd, 0.5);
  assert.deepEqual(log, [
    'gave up on run "quiet": it never ended and has had no generation for 24 hours',
  ]);
});

test('given a run whose runner is still beating but has had no generation since it started 24 hours ago, when the settle step runs, then its cost is unconfirmed at nothing and the give-up is logged', async () => {
  const store = Store.open(':memory:');
  startedRun(store, 'quiet-from-start', { generatedAt: null, aliveAt: BEATING });
  const log: string[] = [];

  await settleGenerations({
    store,
    lookUp: async () => billed(0.25),
    now: () => NOW,
    log: (line) => log.push(line),
  });

  assert.equal(store.getRun('quiet-from-start')?.costStatus, 'unconfirmed');
  assert.equal(store.getRun('quiet-from-start')?.costUsd, 0);
  assert.deepEqual(log, [
    'gave up on run "quiet-from-start": it never ended and has had no generation for 24 hours',
  ]);
});

test('given a run given up because it never ended, when its runner later finalizes it, then its cost stays unconfirmed', async () => {
  const store = Store.open(':memory:');
  startedRun(store, 'late', { aliveAt: BEATING });
  await settleGenerations({
    store,
    lookUp: async () => billed(0.25),
    now: () => NOW,
    log: () => {},
  });

  finish(store, 'late', NOW);

  assert.equal(store.getRun('late')?.costStatus, 'unconfirmed');
  assert.equal(store.getRun('late')?.costUsd, 0.25);
});

test('given running runs whose runner last beat just over two minutes ago, whose runner never beat and started just over two minutes ago, and whose runner beat just under two minutes ago, when the settle step runs, then the first two end as interrupted when last seen, with what was billed as unconfirmed, a given-up row recording why and the interruption logged, and the third keeps running', async () => {
  const store = Store.open(':memory:');
  const lastBeat = endedAgo(121_000);
  const started = endedAgo(121_000);
  startedRun(store, 'killed', {
    startTime: endedAgo(600_000),
    generatedAt: endedAgo(300_000),
    aliveAt: lastBeat,
  });
  startedRun(store, 'never-beat', { startTime: started, generatedAt: null });
  startedRun(store, 'alive', {
    startTime: endedAgo(600_000),
    generatedAt: endedAgo(300_000),
    aliveAt: endedAgo(119_000),
  });
  const log: string[] = [];

  await settleGenerations({
    store,
    lookUp: async () => billed(0.25),
    now: () => NOW,
    log: (line) => log.push(line),
  });

  assert.deepEqual(
    ['killed', 'never-beat', 'alive'].map((id) => {
      const run = store.getRun(id);
      return {
        id,
        status: run?.status,
        endTime: run?.endTime,
        error: run?.error,
        costStatus: run?.costStatus,
        costUsd: run?.costUsd,
      };
    }),
    [
      {
        id: 'killed',
        status: 'interrupted',
        endTime: lastBeat,
        error: `runner stopped without finishing, last seen at ${lastBeat}`,
        costStatus: 'unconfirmed',
        costUsd: 0.25,
      },
      {
        id: 'never-beat',
        status: 'interrupted',
        endTime: started,
        error: `runner stopped without finishing, last seen at ${started}`,
        costStatus: 'unconfirmed',
        costUsd: 0,
      },
      {
        id: 'alive',
        status: 'running',
        endTime: null,
        error: null,
        costStatus: 'pending',
        costUsd: 0.25,
      },
    ],
  );
  assert.deepEqual(
    store
      .listGenerations('killed')
      .map(({ generationId, givenUpAt, lastError }) => ({ generationId, givenUpAt, lastError })),
    [
      { generationId: 'gen-killed', givenUpAt: null, lastError: null },
      {
        generationId: null,
        givenUpAt: NOW,
        lastError: 'run never ended, so later generations may be unrecorded',
      },
    ],
  );
  assert.deepEqual(log, [
    `run "killed" was interrupted: its runner stopped without finishing, last seen at ${lastBeat}`,
    `run "never-beat" was interrupted: its runner stopped without finishing, last seen at ${started}`,
  ]);
});
