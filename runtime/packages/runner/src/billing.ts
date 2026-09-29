import type { LookupResult, Store, UnsettledGeneration } from '@forge/shared';
import type { Lookup, LookUp } from './openrouter.ts';

const CONCURRENT_LOOKUPS = 4;

const GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;

export interface SettleOptions {
  store: Store;
  lookUp: LookUp;
  now: () => string;
  log: (line: string) => void;
}

const lookUpAll = async (
  generations: UnsettledGeneration[],
  lookUp: LookUp,
): Promise<Lookup[]> => {
  const lookups: Lookup[] = [];
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
  lookup: Lookup,
  attemptedAt: string,
): LookupResult => {
  if (lookup.outcome === 'billed') {
    return { id: generation.id, billedCostUsd: lookup.costUsd };
  }
  if (lookup.outcome === 'permanent') {
    return { id: generation.id, error: lookup.reason, givenUp: true };
  }
  const overdue =
    Date.parse(attemptedAt) - Date.parse(generation.since) > GIVE_UP_AFTER_MS;
  return overdue
    ? {
        id: generation.id,
        error: `${lookup.reason}, still unbilled 24 hours after the run ended`,
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
    resultOf(generation, lookups[index] as Lookup, attemptedAt),
  );
  store.recordLookups(results, attemptedAt);
  results.forEach((result, index) => {
    if ('givenUp' in result && result.givenUp) {
      const { generationId, runId } = generations[index] as UnsettledGeneration;
      log(
        `gave up on OpenRouter generation ${JSON.stringify(generationId)} of run ${runId}: ${result.error}`,
      );
    }
  });
};
