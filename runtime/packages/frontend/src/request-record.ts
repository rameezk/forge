import { hashOf, isFields, systemHashesOf, toolsHashOf } from '@forge/shared';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
}

export interface WorkloadContext {
  systemPrompt: string | null;
  tools: ToolDefinition[] | null;
}

type Fields = Record<string, unknown>;

const textIn = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textIn).filter((text) => text !== '').join('\n\n');
  if (!isFields(value)) return '';
  if (typeof value.text === 'string') return value.text;
  return textIn(value.content);
};

const stringOr = (value: unknown, fallback: unknown): string =>
  typeof value === 'string' ? value : typeof fallback === 'string' ? fallback : '';

const toolOf = (tool: unknown): ToolDefinition => {
  const fields = isFields(tool) ? tool : {};
  const fn = isFields(fields.function) ? fields.function : {};
  return {
    name: stringOr(fields.name, fn.name),
    description: stringOr(fields.description, fn.description),
    parameters: fields.input_schema ?? fn.parameters ?? fields.parameters ?? null,
  };
};

export interface RequestRecordView {
  context: WorkloadContext;
  efforts: CallEfforts;
}

export const readRequestRecord = (
  scan: (visit: (record: unknown) => boolean) => void,
): RequestRecordView => {
  const efforts = new Map<string | null, string[]>();
  const systemPrompts = new Map<string, unknown>();
  const toolLists = new Map<string, unknown[]>();
  let body: Fields | undefined;
  scan((line) => {
    if (!isFields(line) || typeof line.type !== 'string') return true;
    if (line.type === 'system_prompt' && typeof line.hash === 'string') {
      systemPrompts.set(line.hash, line.value);
    } else if (line.type === 'tools' && typeof line.hash === 'string' && Array.isArray(line.tools)) {
      toolLists.set(line.hash, line.tools);
    } else if (line.type === 'request' && isFields(line.body)) {
      const scope = typeof line.subagent === 'string' ? line.subagent : null;
      const sent = efforts.get(scope) ?? [];
      sent.push(effortSentIn(line.body));
      efforts.set(scope, sent);
      if (line.subagent === undefined && body === undefined) body = line.body;
    }
    return true;
  });
  if (body === undefined) return { context: { systemPrompt: null, tools: null }, efforts };
  const systemHash = systemHashesOf(body)[0];
  const systemPrompt = systemHash === undefined ? undefined : systemPrompts.get(systemHash);
  const toolsHash = toolsHashOf(body);
  const tools = toolsHash === undefined ? undefined : toolLists.get(toolsHash);
  return {
    context: {
      systemPrompt: systemPrompt === undefined ? null : textIn(systemPrompt),
      tools: tools === undefined ? null : tools.map(toolOf),
    },
    efforts,
  };
};

export const DEFAULT_EFFORT = 'default';

export type CallEfforts = ReadonlyMap<string | null, readonly string[]>;

const KNOWN_EFFORTS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

const effortSentIn = (body: Fields): string => {
  const { reasoning, output_config: outputConfig } = body;
  const effort = isFields(reasoning)
    ? reasoning.effort
    : isFields(outputConfig)
      ? outputConfig.effort
      : undefined;
  if (effort === undefined || effort === '') return DEFAULT_EFFORT;
  const level = effort === 'none' ? 'off' : effort;
  return typeof level === 'string' && KNOWN_EFFORTS.has(level) ? level : 'unknown';
};
