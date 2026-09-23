import { withEffort, type Worker } from './harness.ts';

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
  if (!Object.hasOwn(config.workers, name) || worker === undefined) {
    throw new Error(`unknown worker '${name}'`);
  }
  if (
    !Object.hasOwn(config.harnesses, worker.harness) ||
    config.harnesses[worker.harness] === undefined
  ) {
    throw new Error(
      `worker '${name}' references undeclared harness '${worker.harness}'`,
    );
  }
  return {
    name,
    harness: worker.harness,
    model: worker.model,
    prompt: worker.prompt,
    ...withEffort(worker.reasoningEffort),
  };
};
