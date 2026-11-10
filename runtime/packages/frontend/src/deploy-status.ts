import { readFileSync } from 'node:fs';

export interface DeployStatus {
  running: string | null;
  head: string | null;
  error: string | null;
}

const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

export const parseDeployStatus = (text: string): DeployStatus | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  return { running: textOrNull(record.running), head: textOrNull(record.head), error: textOrNull(record.error) };
};

export const readDeployStatus = (path: string): DeployStatus | null => {
  try {
    return parseDeployStatus(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};
