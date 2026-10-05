import type { TokenUsage } from './events.ts';

export interface NewGeneration {
  runId: string;
  generationId: string | null;
  subagent: string | null;
  usage: TokenUsage;
  estimatedCostUsd: number | null;
  createdAt: string;
}

export interface GenerationRecord extends Omit<NewGeneration, 'usage'> {
  usage: TokenUsage | null;
  billedCostUsd: number | null;
  reasoningTokens: number | null;
  provider: string | null;
  servedModel: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  givenUpAt: string | null;
}

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
