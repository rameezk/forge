export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface MessageEvent {
  type: 'message';
  role: 'assistant' | 'user' | 'system' | 'tool';
  text: string;
  usage: TokenUsage;
  costUsd: number;
}

export interface ResultEvent {
  type: 'result';
  status: 'success' | 'error';
  sessionId: string | null;
  error: string | null;
}

export type HarnessEvent = MessageEvent | ResultEvent;
