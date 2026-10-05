import {
  STALE_AFTER_MS,
  type LookupResult,
  type Store,
  type UnsettledGeneration,
} from '@forge/shared';
import type { LookupOutcome, LookUpGeneration } from './openrouter.ts';

const CONCURRENT_LOOKUPS = 4;

const GIVE_UP_AFTER_HOURS = 24;

const GIVE_UP_AFTER_MS = GIVE_UP_AFTER_HOURS * 60 * 60 * 1000;

export interface SettleOptions {
  store: Store;
  lookUp: LookUpGeneration;
  now: () => string;
  log: (line: string) => void;
}

const lookUpAll = async (
  generations: UnsettledGeneration[],
  lookUp: LookUpGeneration,
): Promise<LookupOutcome[]> => {
  const lookups: LookupOutcome[] = [];
  let next = 0;
  const lookUpRemaining = async (): Promise<void> => {
    for (let index = next++; index < generations.length; index = next++) {
      lookups[index] = await lookUp(
        (generations[index] as UnsettledGeneration).generationId,
      );
    }
  };
  await Promise.all(
    Array.from({ length: CONCURRENT_LOOKUPS }, lookUpRemaining),
  );
  return lookups;
};

const resultOf = (
  generation: UnsettledGeneration,
  lookup: LookupOutcome,
  attemptedAt: string,
): LookupResult => {
  if (lookup.outcome === 'billed') {
    return { id: generation.id, billing: lookup.billing };
  }
  if (lookup.outcome === 'permanent') {
    return { id: generation.id, error: lookup.reason, givenUp: true };
  }
  const overdue =
    Date.parse(attemptedAt) - Date.parse(generation.since) > GIVE_UP_AFTER_MS;
  return overdue
    ? {
        id: generation.id,
        error: `${lookup.reason}, still unbilled after ${GIVE_UP_AFTER_HOURS} hours`,
        givenUp: true,
      }
    : { id: generation.id, error: lookup.reason, givenUp: false };
};

export const settleGenerations = async ({
  store,
  lookUp,
  now,
  log,
}: SettleOptions): Promise<void> => {
  const generations = store.unsettledGenerations();
  const lookups = await lookUpAll(generations, lookUp);
  const attemptedAt = now();
  const results = generations.map((generation, index) =>
    resultOf(generation, lookups[index] as LookupOutcome, attemptedAt),
  );
  store.recordLookups(results, attemptedAt);
  results.forEach((result, index) => {
    if ('givenUp' in result && result.givenUp) {
      const { generationId, runId } = generations[index] as UnsettledGeneration;
      log(
        `gave up on OpenRouter generation ${JSON.stringify(generationId)} of run ${JSON.stringify(runId)}: ${result.error}`,
      );
    }
  });
  const staleSince = new Date(Date.parse(attemptedAt) - STALE_AFTER_MS).toISOString();
  for (const { id, lastSeen } of store.interruptStaleRuns(staleSince, attemptedAt)) {
    log(
      `run ${JSON.stringify(id)} was interrupted: its runner stopped without finishing, last seen at ${lastSeen}`,
    );
  }
  const quietSince = new Date(
    Date.parse(attemptedAt) - GIVE_UP_AFTER_MS,
  ).toISOString();
  for (const runId of store.giveUpUnfinishedRuns(quietSince, attemptedAt)) {
    log(
      `gave up on run ${JSON.stringify(runId)}: it never ended and has had no generation for ${GIVE_UP_AFTER_HOURS} hours`,
    );
  }
};
