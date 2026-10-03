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

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type SubagentUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type SubagentResponse = {
  responseId?: string;
  usage: SubagentUsage;
};

export type SubagentDetails = {
  responses: SubagentResponse[];
  error?: string;
};

export type SubagentUpdate = {
  event: JsonValue;
};
