import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  errorMessage,
  canonicalHash,
  fingerprintHash,
  isFields,
  sha256,
  systemHashesOf,
  toolsHashOf,
  type ConfigFingerprint,
  type RunFingerprint,
} from '@forge/shared';
import type { Checkout, HarnessIdentity, Worker } from './harness.ts';
import { DEFAULT_PROVIDER } from './provider.ts';

const filesUnder = (dir: string): string[] =>
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

const contentHash = (path: string): string => {
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

const WORK_DIR = '<work dir>';

const realpathOrSelf = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

const withoutWorkDir = (value: unknown, workDir: string): string => {
  let text = JSON.stringify(value);
  for (const path of new Set([realpathOrSelf(workDir), workDir])) {
    text = text.replaceAll(path, WORK_DIR);
  }
  return text;
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
  workDir: string;
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
        sha256(withoutWorkDir(line.value, this.#inputs.workDir)),
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
    const { worker, identity, skills, baseCommit, forgeGitSha, record } = this.#inputs;
    const fingerprint: ConfigFingerprint = {
      ...(worker.provider === DEFAULT_PROVIDER ? {} : { provider: worker.provider }),
      model: worker.model,
      reasoningEffort: worker.reasoningEffort ?? null,
      harnessArgs: identity.args,
      harnessVersion: identity.version,
      promptTemplate: sha256(worker.promptTemplate ?? worker.prompt),
      systemPrompt,
      tools,
      skills,
    };
    try {
      record({ fingerprint, hash: fingerprintHash(fingerprint), forgeGitSha, baseCommit });
    } catch (error) {
      process.stderr.write(`could not record the workload's fingerprint: ${errorMessage(error)}\n`);
    }
  }
}
