import { withEffort, type Worker } from './harness.ts';
import REASONING_EFFORTS from './reasoning-efforts.json' with { type: 'json' };
import HARNESS_PROVIDERS from './harness-providers.json' with { type: 'json' };
import {
  ALLOWED_PROVIDERS,
  DEFAULT_PROVIDER,
  isProvider,
} from './provider.ts';

export interface HarnessConfig {
  command: string;
  args?: string[];
}

export interface WorkerConfig {
  harness: string;
  model: string;
  prompt: string;
  provider?: string;
  reasoningEffort?: string;
  timeoutSeconds?: number | null;
  maxCostUsd?: number | null;
}

export interface RepositoryConfig {
  github: string;
  on?: { ticket?: string };
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

const effortsOf = (harness: string): readonly string[] | undefined =>
  Object.hasOwn(REASONING_EFFORTS, harness)
    ? REASONING_EFFORTS[harness as keyof typeof REASONING_EFFORTS]
    : undefined;

const providerOf = (harness: string): string | undefined =>
  Object.hasOwn(HARNESS_PROVIDERS, harness)
    ? HARNESS_PROVIDERS[harness as keyof typeof HARNESS_PROVIDERS]
    : undefined;

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
  const efforts = effortsOf(worker.harness);
  if (
    reasoningEffort !== undefined &&
    efforts !== undefined &&
    !efforts.includes(reasoningEffort)
  ) {
    throw new Error(
      `worker '${name}' reasoning effort '${reasoningEffort}' must be one of ${efforts.join(', ')} for harness '${worker.harness}'`,
    );
  }
  const takenProvider = providerOf(worker.harness);
  const provider = worker.provider ?? takenProvider ?? DEFAULT_PROVIDER;
  if (!isProvider(provider)) {
    throw new Error(
      `worker '${name}' provider '${provider}' must be one of ${ALLOWED_PROVIDERS.join(', ')}`,
    );
  }
  if (takenProvider !== undefined && provider !== takenProvider) {
    throw new Error(
      `worker '${name}' pairs harness '${worker.harness}' with provider '${provider}': harness '${worker.harness}' only takes provider ${takenProvider}`,
    );
  }
  return {
    name,
    harness: worker.harness,
    model: worker.model,
    prompt: worker.prompt,
    provider,
    ...withEffort(reasoningEffort),
    timeoutSeconds: worker.timeoutSeconds ?? null,
    maxCostUsd: worker.maxCostUsd ?? null,
  };
};
