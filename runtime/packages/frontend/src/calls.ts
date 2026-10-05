import type { GenerationRecord } from '@forge/shared';

export const isCall = ({ generationId, usage }: GenerationRecord): boolean =>
  generationId !== null || usage !== null;

export const promptTokens = (usage: NonNullable<GenerationRecord['usage']>): number =>
  usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;

const CACHE_MISS_BELOW = 0.5;

export const cacheMisses = (calls: GenerationRecord[]): ReadonlySet<GenerationRecord> => {
  const previousPrompt = new Map<string | null, number>();
  const misses = new Set<GenerationRecord>();
  for (const call of calls) {
    const { usage } = call;
    if (usage === null) continue;
    const previous = previousPrompt.get(call.subagent);
    if (previous !== undefined && usage.cacheReadTokens < previous * CACHE_MISS_BELOW) {
      misses.add(call);
    }
    previousPrompt.set(call.subagent, promptTokens(usage));
  }
  return misses;
};
