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
  'A command killed with exit 137 most likely hit the workload memory limit, so choose a narrower check rather than retrying it.',
].join(' ');

export interface Workspace {
  workDir: string;
  checkout?: Checkout;
  devShell?: DevShell;
}

export interface HarnessInvocation extends Workspace {
  agentDir: string;
  model: string;
  prompt: string;
  reasoningEffort?: string;
}

export type RawEventSink = (event: unknown) => void;

export type RequestRecordSink = (line: unknown) => void;

export interface HarnessSinks {
  rawEvent: RawEventSink;
  requestRecord: RequestRecordSink;
  stop: AbortSignal;
}

export interface Harness {
  run(
    invocation: HarnessInvocation,
    sinks: HarnessSinks,
  ): AsyncIterable<HarnessEvent>;
}

export interface Worker {
  name: string;
  harness: string;
  model: string;
  prompt: string;
  reasoningEffort?: string;
  timeoutSeconds?: number | null;
  maxCostUsd?: number | null;
}

export const withEffort = (
  effort: string | undefined,
): { reasoningEffort?: string } =>
  effort === undefined ? {} : { reasoningEffort: effort };

export const invocationFor = (
  worker: Worker,
  workspace: Workspace,
  agentDir: string,
): HarnessInvocation => ({
  agentDir,
  model: worker.model,
  prompt: worker.prompt,
  ...workspace,
  ...withEffort(worker.reasoningEffort),
});
