export type RunStatus =
  | 'running'
  | 'success'
  | 'error'
  | 'interrupted'
  | 'exceeded';

export type ExceededLimit = 'budget' | 'timeout';

export type CostStatus = 'pending' | 'billed' | 'unconfirmed' | 'subscription';

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

export interface RunCounters {
  toolCalls: number;
  failedToolResults: number;
  retries: number;
  compactions: number;
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
  aliveAt: string | null;
  harnessStartTime: string | null;
  timeoutSeconds: number | null;
  maxCostUsd: number | null;
  exceededLimit: ExceededLimit | null;
  counters: RunCounters | null;
}

export interface InterruptedRun {
  id: string;
  lastSeen: string;
}

export interface RunResult
  extends Pick<RunRecord, 'status' | 'sessionId' | 'error'> {
  endTime: string;
  exceededLimit?: ExceededLimit;
  counters?: RunCounters;
}
