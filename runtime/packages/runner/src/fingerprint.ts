import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SYSTEM_ROLES } from '@forge/pi-request-record';
import {
  canonicalHash,
  fingerprintHash,
  sha256,
  type ConfigFingerprint,
  type RunFingerprint,
} from '@forge/shared';
import type { Checkout, HarnessIdentity, Worker } from './harness.ts';

const filesUnder = (dir: string): string[] =>
  readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? filesUnder(path) : [path];
    });

export const skillsHash = (checkout: Checkout | undefined): string | null =>
  checkout === undefined
    ? null
    : canonicalHash(
        checkout.skillPaths
          .flatMap(filesUnder)
          .map((path) => [relative(checkout.root, path), sha256(readFileSync(path, 'utf8'))]),
      );

interface Definitions {
  systemPrompt: string | null;
  tools: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hashOf = (value: unknown): string[] =>
  isRecord(value) && typeof value.hash === 'string' ? [value.hash] : [];

export const mainAgentDefinitions = (line: unknown): Definitions | null => {
  if (!isRecord(line) || line.type !== 'request' || line.subagent !== undefined) {
    return null;
  }
  const { body } = line;
  if (!isRecord(body)) return null;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemPrompts = [
    ...hashOf(body.system),
    ...messages.flatMap((message: unknown) =>
      isRecord(message) &&
      typeof message.role === 'string' &&
      SYSTEM_ROLES.has(message.role)
        ? hashOf(message)
        : [],
    ),
  ];
  return {
    systemPrompt: systemPrompts.length === 0 ? null : canonicalHash(systemPrompts),
    tools: hashOf(body.tools)[0] ?? null,
  };
};

export interface FingerprintInputs {
  worker: Worker;
  identity: HarnessIdentity;
  checkout: Checkout | undefined;
  baseCommit: string | null;
  forgeGitSha: string | null;
  record: (fingerprint: RunFingerprint) => void;
}

export class FingerprintRecorder {
  readonly #inputs: FingerprintInputs;
  #recorded = false;

  constructor(inputs: FingerprintInputs) {
    this.#inputs = inputs;
  }

  observe(line: unknown): void {
    const definitions = mainAgentDefinitions(line);
    if (definitions !== null) this.#record(definitions);
  }

  finish(): void {
    this.#record({ systemPrompt: null, tools: null });
  }

  #record({ systemPrompt, tools }: Definitions): void {
    if (this.#recorded) return;
    this.#recorded = true;
    const { worker, identity, checkout, baseCommit, forgeGitSha, record } = this.#inputs;
    const fingerprint: ConfigFingerprint = {
      model: worker.model,
      reasoningEffort: worker.reasoningEffort ?? null,
      harnessArgs: identity.args,
      harnessVersion: identity.version,
      promptTemplate: sha256(worker.promptTemplate ?? worker.prompt),
      systemPrompt,
      tools,
      skills: skillsHash(checkout),
    };
    record({ fingerprint, hash: fingerprintHash(fingerprint), forgeGitSha, baseCommit });
  }
}
