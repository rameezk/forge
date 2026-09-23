export type RunStatus = 'running' | 'success' | 'error';

export interface RunRecord {
  id: string;
  worker: string;
  harness: string;
  model: string;
  startTime: string;
  endTime: string | null;
  status: RunStatus;
  costUncertain: boolean;
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
    | 'costUncertain'
    | 'costUsd'
    | 'inputTokens'
    | 'outputTokens'
    | 'sessionId'
    | 'error'
  > {
  endTime: string;
}
