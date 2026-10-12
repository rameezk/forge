import { join } from 'node:path';
import { agentDirsIn } from './agent-dir.ts';
import { ClaudeCodeHarness } from './claude-code.ts';
import type { HarnessConfig } from './config.ts';
import {
  absolutePath,
  picked,
  sandboxOf,
  systemEnvironment,
} from './environment.ts';
import type { Harness, Worker } from './harness.ts';
import { PiHarness } from './pi.ts';
import { providerSpec } from './provider.ts';

export interface HarnessContext {
  name: string;
  config: HarnessConfig;
  worker: Worker;
  env: NodeJS.ProcessEnv;
  harnessEnv: Record<string, string>;
  stateDir: string;
}

export type HarnessFactory = (context: HarnessContext) => Harness;

export type HarnessRegistry = Readonly<Record<string, HarnessFactory>>;

const piFactory: HarnessFactory = ({
  config,
  worker,
  env,
  harnessEnv,
  stateDir,
}) =>
  new PiHarness({
    command: config.command,
    provider: worker.provider,
    openAgentDir: agentDirsIn(join(stateDir, 'agent'), worker.provider),
    extensions: {
      subagent: absolutePath(env, 'FORGE_PI_SUBAGENT_EXTENSION'),
      modelDefaultReasoning: absolutePath(
        env,
        'FORGE_PI_MODEL_DEFAULT_REASONING_EXTENSION',
      ),
      requestRecord: absolutePath(env, 'FORGE_PI_REQUEST_RECORD_EXTENSION'),
    },
    sandbox: sandboxOf(env),
    ...(config.args === undefined ? {} : { extraArgs: config.args }),
    system: systemEnvironment(env),
    env: {
      ...picked(env, [providerSpec(worker.provider).credentialEnv]),
      ...harnessEnv,
    },
  });

const claudeCodeFactory: HarnessFactory = ({
  config,
  worker,
  env,
  harnessEnv,
  stateDir,
}) =>
  new ClaudeCodeHarness({
    command: config.command,
    runsDir: join(stateDir, 'agent'),
    maxCostUsd: worker.maxCostUsd ?? null,
    sandbox: sandboxOf(env),
    ...(config.args === undefined ? {} : { extraArgs: config.args }),
    system: systemEnvironment(env),
    env: {
      ...picked(env, [providerSpec(worker.provider).credentialEnv]),
      ...harnessEnv,
    },
  });

export const builtInHarnesses: HarnessRegistry = {
  pi: piFactory,
  'claude-code': claudeCodeFactory,
};

export const harnessFor = (
  registry: HarnessRegistry,
  context: HarnessContext,
): Harness => {
  const factory = Object.hasOwn(registry, context.name)
    ? registry[context.name]
    : undefined;
  if (factory === undefined) {
    throw new Error(`unsupported harness '${context.name}'`);
  }
  return factory(context);
};
