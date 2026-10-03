import type { HarnessEvent } from '@forge/shared';
import type { DevShell } from './devshell.ts';

export interface Checkout {
  root: string;
  skillPaths: string[];
  projectInstructions: string | null;
  systemPrompt: string | null;
  appendSystemPrompt: string | null;
  skills: ReadonlyMap<string, readonly string[]>;
}

export const UNATTENDED_INSTRUCTION = [
  'You are running unattended: no human will answer questions or confirm anything while you work.',
  'Where a skill asks you to confirm something the ticket or its spec already settles, proceed without asking.',
  'Otherwise stop, and end with the question you need answered.',
].join(' ');

export interface Workspace {
  workDir: string;
  checkout?: Checkout;
  devShell?: DevShell;
}

export const REASONING_EFFORTS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface HarnessInvocation extends Workspace {
  model: string;
  prompt: string;
  reasoningEffort?: ReasoningEffort;
}

export interface Harness {
  run(invocation: HarnessInvocation): AsyncIterable<HarnessEvent>;
}

export interface Worker {
  name: string;
  harness: string;
  model: string;
  prompt: string;
  reasoningEffort?: ReasoningEffort;
}

export const withEffort = (
  effort: ReasoningEffort | undefined,
): { reasoningEffort?: ReasoningEffort } =>
  effort === undefined ? {} : { reasoningEffort: effort };

export const invocationFor = (
  worker: Worker,
  workspace: Workspace,
): HarnessInvocation => ({
  model: worker.model,
  prompt: worker.prompt,
  ...workspace,
  ...withEffort(worker.reasoningEffort),
});
