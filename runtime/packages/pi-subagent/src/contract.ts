export const SUBAGENT_TOOL = 'subagent';

export const SUBAGENT_INVOCATION_ENV = 'FORGE_SUBAGENT_INVOCATION';

export interface SubagentInvocation {
  argv: string[];
  systemPrompt: string;
}

export interface SubagentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SubagentResponse {
  responseId?: string;
  usage: SubagentUsage;
}

export interface SubagentDetails {
  responses: SubagentResponse[];
}

export interface SubagentUpdate {
  event: unknown;
}
