import type { CostStatus, HarnessEvent } from '@forge/shared';

export interface HarnessInvocation {
  model: string;
  prompt: string;
  workDir: string;
  reasoningEffort?: string;
}

export interface RunCost {
  costUsd: number;
  costStatus: Exclude<CostStatus, 'pending'>;
}

export interface HarnessRun {
  events: AsyncIterable<HarnessEvent>;
  cost(): Promise<RunCost>;
}

export interface Harness {
  run(invocation: HarnessInvocation): HarnessRun;
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
