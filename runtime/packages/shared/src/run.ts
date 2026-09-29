export type RunStatus = 'running' | 'success' | 'error';

export type CostStatus = 'pending' | 'billed' | 'unconfirmed';

export interface RunRecord {
  id: string;
  worker: string;
  harness: string;
  model: string;
  startTime: string;
  endTime: string | null;
  status: RunStatus;
  costStatus: CostStatus;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  transcriptRef: string | null;
  sessionId: string | null;
  error: string | null;
}

export interface RunResult
  extends Pick<
    RunRecord,
    | 'status'
    | 'inputTokens'
    | 'outputTokens'
    | 'sessionId'
    | 'error'
  > {
  endTime: string;
}
