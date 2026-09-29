import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '@forge/shared';
import { settleGenerations } from '../src/index.ts';

const NOW = '2026-09-29T12:00:00.000Z';

const DAY_MS = 24 * 60 * 60 * 1000;

const endedAgo = (ms: number): string =>
  new Date(Date.parse(NOW) - ms).toISOString();

const startedRun = (
  store: Store,
  id: string,
  generatedAt: string = endedAgo(DAY_MS + 30_000),
): void => {
  store.insertRun({
    id,
    worker: 'refiner',
    harness: 'pi',
    model: 'z-ai/glm-5',
    startTime: endedAgo(DAY_MS + 60_000),
    endTime: null,
    status: 'running',
    costStatus: 'pending',
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    transcriptRef: `${id}.jsonl`,
    sessionId: null,
    error: null,
  });
  store.recordGeneration({
    runId: id,
    generationId: `gen-${id}`,
    subagent: null,
    createdAt: generatedAt,
  });
};

const finish = (store: Store, id: string, endTime: string): void => {
  store.finalizeRun(id, {
    endTime,
    status: 'success',
    inputTokens: 100,
    outputTokens: 10,
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
  assert.match(log[0] ?? '', /24 hours/);
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
  startedRun(store, 'live', endedAgo(60_000));

  await settleGenerations({
    store,
    lookUp: async () => ({ outcome: 'billed', costUsd: 0.25 }),
    now: () => NOW,
    log: () => {},
  });

  assert.equal(store.getRun('live')?.costStatus, 'pending');
  assert.equal(store.getRun('live')?.costUsd, 0.25);
  finish(store, 'live', NOW);
  assert.equal(store.getRun('live')?.costStatus, 'billed');
  assert.equal(store.getRun('live')?.costUsd, 0.25);
});

test('given a run whose runner was killed so it never ended, when the settle step runs 24 hours after its last generation, then its cost is unconfirmed with what was billed and the give-up is logged, while a run still within the window stays pending', async () => {
  const store = Store.open(':memory:');
  startedRun(store, 'killed');
  startedRun(store, 'recent');
  store.recordGeneration({
    runId: 'recent',
    generationId: 'gen-recent-late',
    subagent: null,
    createdAt: endedAgo(DAY_MS - 1000),
  });
  const log: string[] = [];

  await settleGenerations({
    store,
    lookUp: async () => ({ outcome: 'billed', costUsd: 0.25 }),
    now: () => NOW,
    log: (line) => log.push(line),
  });

  assert.equal(store.getRun('killed')?.status, 'running');
  assert.equal(store.getRun('killed')?.costStatus, 'unconfirmed');
  assert.equal(store.getRun('killed')?.costUsd, 0.25);
  assert.equal(store.getRun('recent')?.costStatus, 'pending');
  assert.equal(store.getRun('recent')?.costUsd, 0.5);
  assert.deepEqual(log, [
    'gave up on run "killed": it never ended and has had no generation for 24 hours',
  ]);
});
