export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface MessageEvent {
  type: 'message';
  role: 'assistant' | 'user' | 'system' | 'tool';
  text: string;
  thinking?: string;
  timestamp?: string;
  stopReason?: string;
  error?: string;
  usage: TokenUsage;
  generationId: string | null;
  subagent?: string;
}

export interface ToolCallEvent {
  type: 'tool_call';
  id: string;
  name: string;
  arguments: unknown;
  subagent?: string;
}

export interface ToolResultEvent {
  type: 'tool_result';
  id: string;
  isError: boolean;
  text: string;
  subagent?: string;
}

export interface RetryEvent {
  type: 'retry';
  attempt: number | null;
  maxAttempts: number | null;
  delayMs: number | null;
  error: string | null;
  subagent?: string;
}

export interface CompactionEvent {
  type: 'compaction';
  reason: string | null;
  tokensBefore: number | null;
  tokensAfter: number | null;
  summary: string | null;
  error: string | null;
  subagent?: string;
}

export interface ResultEvent {
  type: 'result';
  status: 'success' | 'error';
  sessionId: string | null;
  error: string | null;
}

export type HarnessEvent =
  | MessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | RetryEvent
  | CompactionEvent
  | ResultEvent;
