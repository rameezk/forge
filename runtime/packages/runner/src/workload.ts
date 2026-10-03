import { mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type RunRecord, type RunTicket } from '@forge/shared';
import type { RuntimeConfig } from './config.ts';
import type { Harness, Worker, Workspace } from './harness.ts';
import { openRouterBaseUrl, openRouterListPrice } from './openrouter.ts';
import { PiHarness } from './pi.ts';
import type { Sandbox } from './sandbox.ts';
import { FileRawEvents, FileTranscript } from './transcript.ts';
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

const SYSTEM_VARIABLES = ['PATH', 'LANG', 'LOCALE_ARCHIVE', 'TZDIR'];

const picked = (
  env: NodeJS.ProcessEnv,
  names: string[],
): Record<string, string> =>
  Object.fromEntries(
    names.flatMap((name) => {
      const value = env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );

export const systemEnvironment = (
  env: NodeJS.ProcessEnv,
): Record<string, string> => picked(env, SYSTEM_VARIABLES);

export const sandboxOf = (env: NodeJS.ProcessEnv): Sandbox => ({
  bwrap: absolutePath(env, 'FORGE_BWRAP'),
  home: absolutePath(env, 'HOME'),
});

const harnessEnvironment = (
  env: NodeJS.ProcessEnv,
  harnessEnv: Record<string, string>,
): Record<string, string> => ({
  ...picked(env, ['OPENROUTER_API_KEY']),
  ...harnessEnv,
});

const harnessFor = (
  config: RuntimeConfig,
  worker: Worker,
  env: NodeJS.ProcessEnv,
  harnessEnv: Record<string, string>,
): Harness => {
  const harness = config.harnesses[worker.harness];
  if (harness === undefined || worker.harness !== 'pi') {
    throw new Error(`unsupported harness '${worker.harness}'`);
  }
  const extensions = {
    subagent: absolutePath(env, 'FORGE_PI_SUBAGENT_EXTENSION'),
    modelDefaultReasoning: absolutePath(
      env,
      'FORGE_PI_MODEL_DEFAULT_REASONING_EXTENSION',
    ),
  };
  const agentDir = absolutePath(env, 'FORGE_PI_AGENT_DIR');
  return new PiHarness({
    command: harness.command,
    extensions,
    agentDir,
    sandbox: sandboxOf(env),
    ...(harness.args === undefined ? {} : { extraArgs: harness.args }),
    system: systemEnvironment(env),
    env: harnessEnvironment(env, harnessEnv),
  });
};

export interface LaunchOptions {
  config: RuntimeConfig;
  worker: Worker;
  env: NodeJS.ProcessEnv;
  openWorkspace: (workDir: string) => Workspace | Promise<Workspace>;
  harnessEnv?: Record<string, string>;
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
  harnessEnv = {},
  ticket,
  secrets = [],
  runId = randomUUID(),
}: LaunchOptions): Promise<LaunchResult> => {
  const stateDir = stateDirOf(env);
  const harness = harnessFor(config, worker, env, harnessEnv);
  const lookUpListPrice = openRouterListPrice(openRouterBaseUrl(env));

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
      openRawEvents: (runId) => FileRawEvents.open(transcriptsDir, runId),
      openWorkspace: (runId) => openWorkspace(join(workDirs, runId)),
      now: () => new Date().toISOString(),
      newId: () => runId,
      lookUpListPrice,
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
