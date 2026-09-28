export const SUBAGENT_TOOL = 'subagent';

export const SUBAGENT_INVOCATION_ENV = 'FORGE_PI_SUBAGENT_INVOCATION';

export interface SubagentInvocation {
  argv: string[];
  systemPrompt: string;
}

export const childArgs = (
  invocation: SubagentInvocation,
  task: string,
): string[] => [
  ...invocation.argv.slice(1),
  '--append-system-prompt',
  invocation.systemPrompt,
  `Task: ${task}`,
];

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
