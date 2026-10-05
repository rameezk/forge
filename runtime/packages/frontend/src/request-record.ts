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

const isFields = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const SYSTEM_ROLES = new Set(['system', 'developer']);

const textIn = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textIn).filter((text) => text !== '').join('\n\n');
  if (!isFields(value)) return '';
  if (typeof value.text === 'string') return value.text;
  return textIn(value.content);
};

const hashOf = (reference: unknown): string | undefined =>
  isFields(reference) && typeof reference.hash === 'string' ? reference.hash : undefined;

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

const systemReferenceOf = (body: Fields): string | undefined => {
  const system = hashOf(body.system);
  if (system !== undefined) return system;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const message = messages.find(
    (reference) => isFields(reference) && typeof reference.role === 'string' && SYSTEM_ROLES.has(reference.role),
  );
  return hashOf(message);
};

export const workloadContext = (
  scan: (visit: (record: unknown) => boolean) => void,
): WorkloadContext => {
  const systemPrompts = new Map<string, unknown>();
  const toolLists = new Map<string, unknown[]>();
  let body: Fields | undefined;
  scan((line) => {
    if (!isFields(line) || typeof line.type !== 'string') return true;
    if (line.type === 'system_prompt' && typeof line.hash === 'string') {
      systemPrompts.set(line.hash, line.value);
    } else if (line.type === 'tools' && typeof line.hash === 'string' && Array.isArray(line.tools)) {
      toolLists.set(line.hash, line.tools);
    } else if (line.type === 'request' && line.subagent === undefined && isFields(line.body)) {
      body = line.body;
      return false;
    }
    return true;
  });
  if (body === undefined) return { systemPrompt: null, tools: null };
  const systemHash = systemReferenceOf(body);
  const systemPrompt = systemHash === undefined ? undefined : systemPrompts.get(systemHash);
  const toolsHash = hashOf(body.tools);
  const tools = toolsHash === undefined ? undefined : toolLists.get(toolsHash);
  return {
    systemPrompt: systemPrompt === undefined ? null : textIn(systemPrompt),
    tools: tools === undefined ? null : tools.map(toolOf),
  };
};

export const DEFAULT_EFFORT = 'default';

export type CallEfforts = ReadonlyMap<string | null, readonly string[]>;

const effortSentIn = (body: Fields): string => {
  const { reasoning } = body;
  const effort = isFields(reasoning) ? reasoning.effort : undefined;
  if (typeof effort !== 'string' || effort === '') return DEFAULT_EFFORT;
  return effort === 'none' ? 'off' : effort;
};

export const callEfforts = (
  scan: (visit: (record: unknown) => boolean) => void,
): CallEfforts => {
  const efforts = new Map<string | null, string[]>();
  scan((line) => {
    if (!isFields(line) || line.type !== 'request' || !isFields(line.body)) return true;
    const scope = typeof line.subagent === 'string' ? line.subagent : null;
    efforts.set(scope, [...(efforts.get(scope) ?? []), effortSentIn(line.body)]);
    return true;
  });
  return efforts;
};
