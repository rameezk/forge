import { readFileSync } from 'node:fs';

export interface DeployStatus {
  running: string | null;
  head: string | null;
  error: string | null;
  forge: string | null;
  upstream: string | null;
  upstreamHead: string | null;
  behind: number | null;
}

const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

const COMMIT = /^[0-9a-f]{7,64}$/;

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const matching = (value: unknown, pattern: RegExp): string | null => (typeof value === 'string' && pattern.test(value) ? value : null);

const count = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null);

export const parseDeployStatus = (text: string): DeployStatus | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  return {
    running: textOrNull(record.running),
    head: textOrNull(record.head),
    error: textOrNull(record.error),
    forge: matching(record.forge, COMMIT),
    upstream: matching(record.upstream, REPOSITORY),
    upstreamHead: matching(record.upstreamHead, COMMIT),
    behind: count(record.behind),
  };
};

export const readDeployStatus = (path: string): DeployStatus | null => {
  try {
    return parseDeployStatus(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};
