import { mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type RunRecord, type RunTicket } from '@forge/shared';
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

export const stateDirOf = (env: NodeJS.ProcessEnv): string => {
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
  ticket,
  secrets = [],
  runId = randomUUID(),
}: LaunchOptions): Promise<LaunchResult> => {
  const stateDir = stateDirOf(env);
  const harness = harnessFor(config, worker, env);

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
      openTranscript: (runId) => FileTranscript.open(transcriptsDir, runId),
      openWorkspace: (runId) => openWorkspace(join(workDirs, runId)),
      now: () => new Date().toISOString(),
      newId: () => runId,
      secrets: [env.OPENROUTER_API_KEY ?? '', ...secrets],
      ...(ticket === undefined ? {} : { ticket }),
    });
    const run = store.getRun(id);
    if (run === undefined) throw new Error(`run ${id} was not recorded`);
    return { run, finalMessage, cause };
  } finally {
    store.close();
  }
};
