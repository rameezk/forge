import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type RunRecord, type RunTicket } from '@forge/shared';
import type { RuntimeConfig } from './config.ts';
import type { Worker, Workspace } from './harness.ts';
import { stateDirOf } from './environment.ts';
import { builtInHarnesses, harnessFor, type HarnessRegistry } from './harnesses.ts';
import {
  openRouterBaseUrl,
  openRouterModel,
  type LookUpModel,
} from './openrouter.ts';
import { providerSpec, type Provider } from './provider.ts';
import { anthropicModel } from './anthropic-models.ts';
import { JsonLinesFile } from './transcript.ts';
import { runWorkload } from './runner.ts';

export {
  absolutePath,
  sandboxOf,
  stateDirOf,
  systemEnvironment,
} from './environment.ts';

export const readRuntimeConfig = (env: NodeJS.ProcessEnv): RuntimeConfig => {
  const configPath = env.FORGE_RUNTIME_CONFIG;
  if (configPath === undefined) {
    throw new Error('FORGE_RUNTIME_CONFIG is not set');
  }
  return JSON.parse(readFileSync(configPath, 'utf8')) as RuntimeConfig;
};

const modelLookUpFor = (
  provider: Provider,
  env: NodeJS.ProcessEnv,
): LookUpModel => {
  switch (provider) {
    case 'openrouter':
      return openRouterModel(openRouterBaseUrl(env));
    case 'anthropic':
      return anthropicModel(openRouterModel(openRouterBaseUrl(env)));
  }
};

export interface LaunchOptions {
  config: RuntimeConfig;
  worker: Worker;
  env: NodeJS.ProcessEnv;
  openWorkspace: (workDir: string) => Workspace | Promise<Workspace>;
  harnessEnv?: Record<string, string>;
  harnesses?: HarnessRegistry;
  ticket?: RunTicket;
  secrets?: () => readonly string[];
  runId?: string;
}

export interface LaunchResult {
  run: RunRecord;
  finalMessage: string | null;
  cause: unknown;
}

export const launchWorkload = async ({
  config,
  worker,
  env,
  openWorkspace,
  harnessEnv = {},
  harnesses = builtInHarnesses,
  ticket,
  secrets = () => [],
  runId = randomUUID(),
}: LaunchOptions): Promise<LaunchResult> => {
  const stateDir = stateDirOf(env);
  const harnessConfig = Object.hasOwn(config.harnesses, worker.harness)
    ? config.harnesses[worker.harness]
    : undefined;
  if (harnessConfig === undefined) {
    throw new Error(`unsupported harness '${worker.harness}'`);
  }
  const harness = harnessFor(harnesses, {
    name: worker.harness,
    config: harnessConfig,
    worker,
    env,
    harnessEnv,
    stateDir,
  });
  const lookUpModel = modelLookUpFor(worker.provider, env);

  const transcriptsDir = join(stateDir, 'transcripts');
  mkdirSync(transcriptsDir, { recursive: true });
  const workDirs = join(stateDir, 'work');
  mkdirSync(workDirs, { recursive: true });
  const store = Store.open(join(stateDir, 'forge.db'));

  try {
    const { id, finalMessage, cause } = await runWorkload({
      store,
      harness,
      worker,
      openTranscript: (runId) => JsonLinesFile.transcript(transcriptsDir, runId),
      openRawEvents: (runId) => JsonLinesFile.rawEvents(transcriptsDir, runId),
      openRequestRecord: (runId) =>
        JsonLinesFile.requestRecord(transcriptsDir, runId),
      openWorkspace: (runId) => openWorkspace(join(workDirs, runId)),
      now: () => new Date().toISOString(),
      newId: () => runId,
      lookUpModel,
      secrets: () => [env[providerSpec(worker.provider).credentialEnv] ?? '', ...secrets()],
      forgeGitSha: env.FORGE_GIT_SHA === undefined || env.FORGE_GIT_SHA === '' ? null : env.FORGE_GIT_SHA,
      ...(ticket === undefined ? {} : { ticket }),
    });
    const run = store.getRun(id);
    if (run === undefined) throw new Error(`run ${id} was not recorded`);
    return { run, finalMessage, cause };
  } finally {
    store.close();
  }
};
