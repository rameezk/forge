import {
  STALE_AFTER_MS,
  countEvents,
  errorMessage,
  skillLoadsOf,
  type HarnessEvent,
  type LookupResult,
  type RunSkillLoad,
  type Runs,
  type UnsettledGeneration,
} from '@forge/shared';
import type { LookupOutcome, LookUpGeneration } from './openrouter.ts';

const CONCURRENT_LOOKUPS = 4;

const GIVE_UP_AFTER_HOURS = 24;

const GIVE_UP_AFTER_MS = GIVE_UP_AFTER_HOURS * 60 * 60 * 1000;

export interface SettleOptions {
  runs: Runs;
  lookUp: LookUpGeneration;
  readTranscript: (ref: string) => HarnessEvent[] | null;
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
  runs,
  lookUp,
  readTranscript,
  now,
  log,
}: SettleOptions): Promise<void> => {
  const generations = runs.unsettledGenerations();
  const lookups = await lookUpAll(generations, lookUp);
  const attemptedAt = now();
  const results = generations.map((generation, index) =>
    resultOf(generation, lookups[index] as LookupOutcome, attemptedAt),
  );
  runs.recordLookups(results, attemptedAt);
  results.forEach((result, index) => {
    if ('givenUp' in result && result.givenUp) {
      const { generationId, runId } = generations[index] as UnsettledGeneration;
      log(
        `gave up on OpenRouter generation ${JSON.stringify(generationId)} of run ${JSON.stringify(runId)}: ${result.error}`,
      );
    }
  });
  const staleSince = new Date(Date.parse(attemptedAt) - STALE_AFTER_MS).toISOString();
  for (const { id, lastSeen } of runs.interruptStaleRuns(staleSince, attemptedAt)) {
    log(
      `run ${JSON.stringify(id)} was interrupted: its runner stopped without finishing, last seen at ${lastSeen}`,
    );
  }
  const quietSince = new Date(
    Date.parse(attemptedAt) - GIVE_UP_AFTER_MS,
  ).toISOString();
  for (const runId of runs.giveUpUnfinishedRuns(quietSince, attemptedAt)) {
    log(
      `gave up on run ${JSON.stringify(runId)}: it never ended and has had no generation for ${GIVE_UP_AFTER_HOURS} hours`,
    );
  }
  for (const { id, transcriptRef } of runs.runsWithoutCounters()) {
    try {
      const events = readTranscript(transcriptRef);
      if (events !== null) {
        runs.recordCounters(id, countEvents(events));
      }
    } catch (error) {
      log(`could not count the transcript of run ${JSON.stringify(id)}: ${errorMessage(error)}`);
    }
  }
  for (const { id, transcriptRef } of runs.runsWithoutSkillLoadRecord()) {
    let loads: RunSkillLoad[] | null = null;
    try {
      const events = transcriptRef === null ? null : readTranscript(transcriptRef);
      loads =
        events === null
          ? null
          : skillLoadsOf(events).map((load) => ({
              ...load,
              runId: id,
              loadedAt: attemptedAt,
            }));
    } catch (error) {
      log(`could not read the skill loads of run ${JSON.stringify(id)}: ${errorMessage(error)}`);
    }
    runs.recordBackfilledSkillLoads(id, loads);
  }
};
