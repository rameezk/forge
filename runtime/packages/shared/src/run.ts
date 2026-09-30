export type RunStatus = 'running' | 'success' | 'error';

export type CostStatus = 'pending' | 'billed' | 'unconfirmed';

export interface RunTicket {
  repository: string;
  number: number;
  url: string;
}

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
  ticket: RunTicket | null;
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
