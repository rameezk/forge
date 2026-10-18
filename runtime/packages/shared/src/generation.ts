import type { TokenUsage } from './events.ts';

export type GenerationKind = 'message' | 'compaction' | 'cache_warm';

export interface NewGeneration {
  runId: string;
  generationId: string | null;
  subagent: string | null;
  kind: GenerationKind;
  usage: TokenUsage;
  estimatedCostUsd: number | null;
  listPriceEquivalentUsd?: number | null;
  givenUpBecause?: string;
  createdAt: string;
}

export interface GenerationRecord
  extends Omit<NewGeneration, 'usage' | 'listPriceEquivalentUsd' | 'givenUpBecause'> {
  usage: TokenUsage | null;
  listPriceEquivalentUsd: number | null;
  billedCostUsd: number | null;
  reasoningTokens: number | null;
  provider: string | null;
  servedModel: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  givenUpAt: string | null;
}

const OPENROUTER_GENERATION_ID = /^gen-/;

export const notOpenRouterIdReason = (generationId: string): string | null =>
  OPENROUTER_GENERATION_ID.test(generationId)
    ? null
    : `${JSON.stringify(generationId)} is not an OpenRouter generation id`;

export const hasUnbillableId = (
  generation: Pick<GenerationRecord, 'generationId' | 'givenUpAt'>,
): boolean =>
  generation.givenUpAt !== null &&
  generation.generationId !== null &&
  notOpenRouterIdReason(generation.generationId) !== null;

export interface UnsettledGeneration {
  id: number;
  runId: string;
  generationId: string;
  since: string;
}

export interface NativeUsage {
  promptTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

export interface Billing {
  costUsd: number;
  usage: NativeUsage | null;
  reasoningTokens: number | null;
  provider: string | null;
  model: string | null;
}

export type LookupResult =
  | { id: number; billing: Billing }
  | { id: number; error: string; givenUp: boolean };
