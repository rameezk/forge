export type RunStatus = 'running' | 'success' | 'error';

export type CostStatus = 'pending' | 'billed' | 'unconfirmed';

export interface RunTicket {
  repository: string;
  number: number;
  url: string;
}

/** OpenRouter's list price for a model, in USD per token. */
export interface ListPrice {
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
}

export interface RunRecord {
  id: string;
  worker: string;
  harness: string;
  model: string;
  reasoningEffort: string | null;
  startTime: string;
  endTime: string | null;
  status: RunStatus;
  costStatus: CostStatus;
  costUsd: number;
  costEstimated: boolean;
  listPrice: ListPrice | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  transcriptRef: string | null;
  sessionId: string | null;
  error: string | null;
  ticket: RunTicket | null;
}

export interface RunResult
  extends Pick<RunRecord, 'status' | 'sessionId' | 'error'> {
  endTime: string;
}
