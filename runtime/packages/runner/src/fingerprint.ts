import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  errorMessage,
  canonicalHash,
  DEFAULT_HARNESS,
  fingerprintHash,
  isFields,
  sha256,
  systemHashesOf,
  toolsHashOf,
  type ConfigFingerprint,
  type RunFingerprint,
} from '@forge/shared';
import type { Checkout, FingerprintBasis, HarnessIdentity, Worker } from './harness.ts';
import { DEFAULT_PROVIDER } from './provider.ts';

export const filesUnder = (dir: string): string[] =>
  readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      try {
        const stat = statSync(path);
        if (stat.isDirectory()) return filesUnder(path);
        return stat.isFile() ? [path] : [];
      } catch {
        return [];
      }
    });

const UNREADABLE = 'unreadable';

export const contentHash = (path: string): string => {
  try {
    return sha256(readFileSync(path, 'utf8'));
  } catch {
    return UNREADABLE;
  }
};

export const skillsHash = (checkout: Checkout | undefined): string | null =>
  checkout === undefined
    ? null
    : canonicalHash(
        checkout.skillPaths
          .flatMap(filesUnder)
          .map((path) => [relative(checkout.root, path), contentHash(path)]),
      );

export const realpathOrSelf = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

export const replacingPaths =
  (placeholders: readonly (readonly [string, string])[]) =>
  (text: string): string => {
    const ordered = placeholders
      .flatMap(([path, placeholder]) =>
        [...new Set([realpathOrSelf(path), path])].map((variant) => [variant, placeholder] as const),
      )
      .sort(([left], [right]) => right.length - left.length);
    return ordered.reduce(
      (replaced, [path, placeholder]) => replaced.replaceAll(path, placeholder),
      text,
    );
  };

const normalized = (value: unknown, normalize: (text: string) => string): unknown => {
  if (typeof value === 'string') return normalize(value);
  if (Array.isArray(value)) return value.map((item) => normalized(item, normalize));
  if (isFields(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [key, normalized(field, normalize)]),
    );
  }
  return value;
};

interface Definitions {
  systemPrompt: string | null;
  tools: string | null;
}

export const mainAgentDefinitions = (
  line: unknown,
  systemPrompts: ReadonlyMap<string, string>,
): Definitions | null => {
  if (!isFields(line) || line.type !== 'request' || line.subagent !== undefined) {
    return null;
  }
  const { body } = line;
  if (!isFields(body)) return null;
  const hashes = systemHashesOf(body);
  return {
    systemPrompt:
      hashes.length === 0
        ? null
        : canonicalHash(hashes.map((hash) => systemPrompts.get(hash) ?? hash)),
    tools: toolsHashOf(body) ?? null,
  };
};

export interface FingerprintInputs {
  worker: Worker;
  identity: HarnessIdentity;
  basis: FingerprintBasis;
  skills: string | null;
  baseCommit: string | null;
  forgeGitSha: string | null;
  record: (fingerprint: RunFingerprint) => void;
}

export class FingerprintRecorder {
  readonly #inputs: FingerprintInputs;
  #recorded = false;
  readonly #systemPrompts = new Map<string, string>();

  constructor(inputs: FingerprintInputs) {
    this.#inputs = inputs;
  }

  observe(line: unknown): void {
    if (isFields(line) && line.type === 'system_prompt' && typeof line.hash === 'string') {
      this.#systemPrompts.set(
        line.hash,
        sha256(JSON.stringify(normalized(line.value, this.#inputs.basis.normalize))),
      );
    }
    const definitions = mainAgentDefinitions(line, this.#systemPrompts);
    if (definitions !== null) this.#record(definitions);
  }

  finish(): void {
    this.#record({ systemPrompt: null, tools: null });
  }

  #record({ systemPrompt, tools }: Definitions): void {
    if (this.#recorded) return;
    this.#recorded = true;
    const { worker, identity, basis, skills, baseCommit, forgeGitSha, record } = this.#inputs;
    const fingerprint: ConfigFingerprint = {
      ...(worker.provider === DEFAULT_PROVIDER ? {} : { provider: worker.provider }),
      ...(worker.harness === DEFAULT_HARNESS ? {} : { harness: worker.harness }),
      model: worker.model,
      reasoningEffort: worker.reasoningEffort ?? null,
      harnessArgs: identity.args,
      harnessVersion: identity.version,
      promptTemplate: sha256(worker.promptTemplate ?? worker.prompt),
      systemPrompt,
      tools,
      skills,
      ...(basis.settings === null ? {} : { settings: basis.settings }),
    };
    try {
      record({ fingerprint, hash: fingerprintHash(fingerprint), forgeGitSha, baseCommit });
    } catch (error) {
      process.stderr.write(`could not record the workload's fingerprint: ${errorMessage(error)}\n`);
    }
  }
}
