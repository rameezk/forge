import type { HarnessEvent } from '@forge/shared';

export interface HarnessInvocation {
  model: string;
  prompt: string;
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

export const invocationFor = (worker: Worker): HarnessInvocation => ({
  model: worker.model,
  prompt: worker.prompt,
  ...(worker.reasoningEffort === undefined
    ? {}
    : { reasoningEffort: worker.reasoningEffort }),
});
