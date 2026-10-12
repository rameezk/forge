import { createHash } from 'node:crypto';
import type {
  CacheMarker,
  Reference,
  RequestPath,
  RequestRecordLine,
} from '@forge/shared';

export const REQUEST_RECORD_FD_ENV = 'FORGE_PI_REQUEST_RECORD_FD';

const CACHE_MARKER = 'cache_control';

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const fields = value as Record<string, unknown>;
    return `{${Object.keys(fields)
      .sort()
      .filter((key) => fields[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(fields[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const contentHash = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const unmarked = (value: unknown, path: RequestPath, markers: CacheMarker[]): unknown => {
  if (Array.isArray(value)) {
    return value.map((item, index) => unmarked(item, [...path, index], markers));
  }
  if (!isRecord(value)) {
    return value;
  }
  const fields: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (key === CACHE_MARKER) {
      markers.push({ path, value: field });
    } else {
      fields[key] = unmarked(field, [...path, key], markers);
    }
  }
  return fields;
};

export const SYSTEM_ROLES = new Set(['system', 'developer']);

export const recordOf = (payload: unknown): RequestRecordLine[] => {
  const cacheMarkers: CacheMarker[] = [];
  const body = unmarked(payload, [], cacheMarkers);
  if (!isRecord(body)) {
    return [{ type: 'request', body, cacheMarkers }];
  }
  const definitions: RequestRecordLine[] = [];
  const systemPrompt = (value: unknown): string => {
    const hash = contentHash(value);
    definitions.push({ type: 'system_prompt', hash, value });
    return hash;
  };
  const reduced: Record<string, unknown> = { ...body };
  if (body.system !== undefined) {
    reduced.system = { hash: systemPrompt(body.system) };
  }
  if (Array.isArray(body.messages)) {
    reduced.messages = body.messages.map((message: unknown): Reference => {
      const role = isRecord(message) ? message.role : undefined;
      return {
        role,
        hash:
          typeof role === 'string' && SYSTEM_ROLES.has(role)
            ? systemPrompt(message)
            : contentHash(message),
      };
    });
  }
  if (Array.isArray(body.tools)) {
    const hash = contentHash(body.tools);
    definitions.push({ type: 'tools', hash, tools: body.tools });
    reduced.tools = { hash };
  }
  return [...definitions, { type: 'request', body: reduced, cacheMarkers }];
};
