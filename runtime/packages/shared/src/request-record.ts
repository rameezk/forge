export type RequestPath = (string | number)[];

export interface CacheMarker {
  path: RequestPath;
  value: unknown;
}

export interface Reference {
  role?: unknown;
  hash: string;
}

export interface SystemPromptDefinition {
  type: 'system_prompt';
  hash: string;
  value: unknown;
}

export interface ToolsDefinition {
  type: 'tools';
  hash: string;
  tools: unknown[];
}

export interface RequestEntry {
  type: 'request';
  subagent?: string;
  body: unknown;
  cacheMarkers: CacheMarker[];
}

export type RequestRecordLine =
  | SystemPromptDefinition
  | ToolsDefinition
  | RequestEntry;

export const SYSTEM_ROLES: ReadonlySet<string> = new Set(['system', 'developer']);

export const isFields = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const hashOf = (reference: unknown): string | undefined =>
  isFields(reference) && typeof reference.hash === 'string'
    ? reference.hash
    : undefined;

export const systemHashesOf = (body: Record<string, unknown>): string[] => {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return [
    hashOf(body.system),
    ...messages.map((message: unknown) =>
      isFields(message) &&
      typeof message.role === 'string' &&
      SYSTEM_ROLES.has(message.role)
        ? hashOf(message)
        : undefined,
    ),
  ].filter((hash): hash is string => hash !== undefined);
};

export const toolsHashOf = (body: Record<string, unknown>): string | undefined =>
  hashOf(body.tools);
