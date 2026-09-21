import type { Worker } from './harness.ts';

export interface HarnessConfig {
  command: string;
  args?: string[];
}

export interface WorkerConfig {
  harness: string;
  model: string;
  prompt: string;
  reasoningEffort?: string;
}

export interface RuntimeConfig {
  harnesses: Record<string, HarnessConfig>;
  workers: Record<string, WorkerConfig>;
}

export const resolveWorker = (
  config: RuntimeConfig,
  name: string,
): Worker => {
  const worker = config.workers[name];
  if (worker === undefined) {
    throw new Error(`unknown worker '${name}'`);
  }
  if (config.harnesses[worker.harness] === undefined) {
    throw new Error(
      `worker '${name}' references undeclared harness '${worker.harness}'`,
    );
  }
  return {
    name,
    harness: worker.harness,
    model: worker.model,
    prompt: worker.prompt,
    ...(worker.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: worker.reasoningEffort }),
  };
};
