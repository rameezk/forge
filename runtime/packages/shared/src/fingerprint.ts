import { createHash } from 'node:crypto';

export interface ConfigFingerprint {
  model: string;
  reasoningEffort: string | null;
  harnessArgs: string[];
  harnessVersion: string | null;
  promptTemplate: string;
  systemPrompt: string | null;
  tools: string | null;
  skills: string | null;
}

export interface RunFingerprint {
  fingerprint: ConfigFingerprint;
  hash: string;
  forgeGitSha: string | null;
  baseCommit: string | null;
}

export const UNKNOWN_CONFIG = 'unknown config';

export const UNKNOWN_COHORT = 'unknown';

export const cohortHref = (hash: string | null): string => `/cohorts/${hash ?? UNKNOWN_COHORT}`;

const SHORT_HASH_LENGTH = 4;

export const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const fields = value as Record<string, unknown>;
    return `{${Object.keys(fields)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(fields[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

export const canonicalHash = (value: unknown): string => sha256(canonical(value));

export const fingerprintHash = (fingerprint: ConfigFingerprint): string =>
  canonicalHash(fingerprint);

const modelName = (model: string): string =>
  (model.split('/').pop() ?? model).replace(/^claude-/, '');

export const cohortLabel = (fingerprint: ConfigFingerprint | null): string =>
  fingerprint === null
    ? UNKNOWN_CONFIG
    : [
        modelName(fingerprint.model),
        fingerprint.reasoningEffort ?? 'default',
        `prompt#${fingerprint.promptTemplate.slice(0, SHORT_HASH_LENGTH)}`,
      ].join(' · ');
