import { withEffort, type Worker } from './harness.ts';
import REASONING_EFFORTS from './reasoning-efforts.json' with { type: 'json' };

export interface HarnessConfig {
  command: string;
  args?: string[];
}

export interface WorkerConfig {
  harness: string;
  model: string;
  prompt: string;
  reasoningEffort?: string;
  timeoutSeconds?: number | null;
}

export interface RepositoryConfig {
  github: string;
  worker?: string;
}

export interface GitIdentity {
  name: string;
  email: string;
}

export interface DispatchConfig {
  gitIdentity?: GitIdentity;
  maxConcurrent?: number;
}

export const DEFAULT_MAX_CONCURRENT = 1;

export const maxConcurrentOf = (config: RuntimeConfig): number =>
  config.dispatch?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;

export interface RuntimeConfig {
  harnesses: Record<string, HarnessConfig>;
  workers: Record<string, WorkerConfig>;
  repositories?: Record<string, RepositoryConfig>;
  dispatch?: DispatchConfig;
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
  if (/^[-@]/.test(worker.prompt)) {
    throw new Error(
      `worker '${name}' prompt must not start with '-' or '@': the harness would parse it as an option or a file`,
    );
  }
  const { reasoningEffort } = worker;
  if (
    reasoningEffort !== undefined &&
    !REASONING_EFFORTS.includes(reasoningEffort)
  ) {
    throw new Error(
      `worker '${name}' reasoning effort '${reasoningEffort}' must be one of ${REASONING_EFFORTS.join(', ')}`,
    );
  }
  return {
    name,
    harness: worker.harness,
    model: worker.model,
    prompt: worker.prompt,
    ...withEffort(reasoningEffort),
    timeoutSeconds: worker.timeoutSeconds ?? null,
  };
};
