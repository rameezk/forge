import { mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type RunTicket } from '@forge/shared';
import type { RuntimeConfig } from './config.ts';
import type { Harness, Worker, Workspace } from './harness.ts';
import { PiHarness } from './pi.ts';
import { FileTranscript } from './transcript.ts';
import { runWorkload } from './runner.ts';

export const absolutePath = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (value === undefined || !isAbsolute(value)) {
    throw new Error(`${name} is not set to an absolute path`);
  }
  return value;
};

export const readRuntimeConfig = (env: NodeJS.ProcessEnv): RuntimeConfig => {
  const configPath = env.FORGE_RUNTIME_CONFIG;
  if (configPath === undefined) {
    throw new Error('FORGE_RUNTIME_CONFIG is not set');
  }
  return JSON.parse(readFileSync(configPath, 'utf8')) as RuntimeConfig;
};

const stateDirOf = (env: NodeJS.ProcessEnv): string => {
  const stateDir = env.FORGE_STATE_DIR;
  if (stateDir === undefined) {
    throw new Error('FORGE_STATE_DIR is not set');
  }
  return stateDir;
};

const harnessFor = (
  config: RuntimeConfig,
  worker: Worker,
  env: NodeJS.ProcessEnv,
): Harness => {
  const harness = config.harnesses[worker.harness];
  if (harness === undefined || worker.harness !== 'pi') {
    throw new Error(`unsupported harness '${worker.harness}'`);
  }
  return new PiHarness({
    command: harness.command,
    extension: absolutePath(env, 'FORGE_PI_SUBAGENT_EXTENSION'),
    agentDir: absolutePath(env, 'FORGE_PI_AGENT_DIR'),
    ...(harness.args === undefined ? {} : { extraArgs: harness.args }),
    env,
  });
};

export interface LaunchOptions {
  config: RuntimeConfig;
  worker: Worker;
  env: NodeJS.ProcessEnv;
  openWorkspace: (workDir: string) => Workspace | Promise<Workspace>;
  ticket?: RunTicket;
  secrets?: string[];
}

export const launchWorkload = async ({
  config,
  worker,
  env,
  openWorkspace,
  ticket,
  secrets = [],
}: LaunchOptions): Promise<number> => {
  const stateDir = stateDirOf(env);
  const harness = harnessFor(config, worker, env);

  const transcriptsDir = join(stateDir, 'transcripts');
  mkdirSync(transcriptsDir, { recursive: true });
  const workDirs = join(stateDir, 'work');
  mkdirSync(workDirs, { recursive: true });
  const store = Store.open(join(stateDir, 'forge.db'));

  try {
    const id = await runWorkload({
      store,
      harness,
      worker,
      openTranscript: (runId) => FileTranscript.open(transcriptsDir, runId),
      openWorkspace: (runId) => openWorkspace(join(workDirs, runId)),
      now: () => new Date().toISOString(),
      newId: () => randomUUID(),
      secrets: [env.OPENROUTER_API_KEY ?? '', ...secrets],
      ...(ticket === undefined ? {} : { ticket }),
    });
    return store.getRun(id)?.status === 'error' ? 1 : 0;
  } finally {
    store.close();
  }
};
