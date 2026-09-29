export interface NewGeneration {
  runId: string;
  generationId: string | null;
  subagent: string | null;
  createdAt: string;
}

export interface GenerationRecord extends NewGeneration {
  billedCostUsd: number | null;
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

export type LookupResult =
  | { id: number; billedCostUsd: number }
  | { id: number; error: string; givenUp: boolean };
