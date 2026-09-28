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

export interface ResultEvent {
  type: 'result';
  status: 'success' | 'error';
  sessionId: string | null;
  error: string | null;
}

export type HarnessEvent =
  MessageEvent | ToolCallEvent | ToolResultEvent | ResultEvent;
