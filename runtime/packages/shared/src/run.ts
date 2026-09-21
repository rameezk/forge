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
