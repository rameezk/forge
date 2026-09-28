import type { HarnessEvent } from '@forge/shared';

export interface HarnessInvocation {
  model: string;
  prompt: string;
  workDir: string;
  reasoningEffort?: string;
}

export interface Harness {
  run(invocation: HarnessInvocation): AsyncIterable<HarnessEvent>;
}

export interface Worker {
  name: string;
  harness: string;
  model: string;
  prompt: string;
  reasoningEffort?: string;
}

export const withEffort = (
  effort: string | undefined,
): { reasoningEffort?: string } =>
  effort === undefined ? {} : { reasoningEffort: effort };

export const invocationFor = (
  worker: Worker,
  workDir: string,
): HarnessInvocation => ({
  model: worker.model,
  prompt: worker.prompt,
  workDir,
  ...withEffort(worker.reasoningEffort),
});
