import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage, type BotIdentity, type GithubApp, type RunTicket } from '@forge/shared';
import type { RuntimeConfig } from './config.ts';
import { cloneCheckout, headCommit, loadPiSkills, resolveCheckout } from './checkout.ts';
import { enterDevShell } from './devshell.ts';
import { gitEnvironment } from './git.ts';
import { boundedBySetupTimeout, type Setup } from './setup.ts';
import { GithubTokenFile, keepFresh } from './github-token-file.ts';
import type { Worker } from './harness.ts';
import { withoutCredentials } from './provider.ts';
import {
  absolutePath,
  launchWorkload,
  sandboxOf,
  stateDirOf,
  systemEnvironment,
  type LaunchResult,
} from './workload.ts';

const nixSystemOf = (env: NodeJS.ProcessEnv): string => {
  const system = env.FORGE_NIX_SYSTEM;
  if (system === undefined) {
    throw new Error('FORGE_NIX_SYSTEM is not set');
  }
  return system;
};

export const launchInCheckout = async ({
  env,
  config,
  worker,
  github,
  workflows,
  branch,
  instruction,
  app,
  gitEnv,
  identity,
  ticket,
  runId,
  conflictResolution = false,
}: {
  env: NodeJS.ProcessEnv;
  config: RuntimeConfig;
  worker: Worker;
  github: string;
  workflows: boolean;
  branch?: string;
  instruction?: string;
  app: GithubApp;
  gitEnv: Record<string, string>;
  identity: BotIdentity;
  ticket?: RunTicket;
  runId: string;
  conflictResolution?: boolean;
}): Promise<LaunchResult> => {
  const loadSkills = await loadPiSkills(absolutePath(env, 'FORGE_PI_PACKAGE'));
  const nixSystem = nixSystemOf(env);
  const hostEnv = withoutCredentials(env);
  const redactions: string[] = [];
  const minted = await app.mint(github, 'workload', { workflows });
  const tokenFile = GithubTokenFile.create(
    join(stateDirOf(env), 'credentials'),
    runId,
    minted.token,
    redactions,
  );
  const stopRefreshing = keepFresh(
    tokenFile,
    minted,
    () => app.mint(github, 'workload', { workflows }),
    (error) =>
      console.error(`could not refresh the workload's GitHub token: ${errorMessage(error)}`),
  );
  const cloneEnv = { ...hostEnv, ...tokenFile.environment, ...gitEnv };
  return launchWorkload({
    config,
    worker,
    env,
    harnessEnv: { ...tokenFile.environment, ...gitEnvironment({}, identity, { conflictResolution }) },
    secrets: () => redactions,
    ...(ticket === undefined ? {} : { ticket }),
    runId,
    openWorkspace: async (workDir, setup) => {
      setup.stage('clone');
      await cloneCheckout(github, workDir, cloneEnv, {
        branch,
        blobless: !conflictResolution,
        signal: setup.signal,
      });
      const baseCommit = await headCommit(workDir, { ...hostEnv, ...gitEnv }, setup.signal);
      setup.signal.throwIfAborted();
      setup.stage('skills');
      const checkout = await resolveCheckout(workDir, loadSkills);
      setup.signal.throwIfAborted();
      setup.stage('devShell');
      const devShell = await enterDevShell({
        sandbox: sandboxOf(env),
        system: nixSystem,
        root: checkout.root,
        env: systemEnvironment(env),
        signal: setup.signal,
      });
      return {
        workDir,
        baseCommit,
        checkout,
        ...(instruction === undefined ? {} : { instruction }),
        ...(devShell === undefined ? {} : { devShell }),
      };
    },
  }).finally(() => {
    stopRefreshing();
    tokenFile.remove();
  });
};

export const inspectCheckout = async <Result>({
  env,
  github,
  branch,
  app,
  gitEnv,
  id,
  inspect,
  setupTimeoutSeconds,
}: {
  env: NodeJS.ProcessEnv;
  github: string;
  branch: string;
  app: GithubApp;
  gitEnv: Record<string, string>;
  id: string;
  inspect: (dir: string, env: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<Result>;
  setupTimeoutSeconds?: number;
}): Promise<Result> => {
  const tokenFile = GithubTokenFile.create(
    join(stateDirOf(env), 'credentials'),
    id,
    (await app.mint(github, 'workload')).token,
    [],
  );
  const dir = join(stateDirOf(env), 'inspections', id);
  const gitEnvWithCredentials = { ...withoutCredentials(env), ...tokenFile.environment, ...gitEnv };
  const inspectIn = async (setup?: Setup): Promise<Result> => {
    setup?.stage('clone');
    await cloneCheckout(github, dir, gitEnvWithCredentials, {
      branch,
      blobless: false,
      ...(setup === undefined ? {} : { signal: setup.signal }),
    });
    setup?.stage('merge');
    return inspect(dir, gitEnvWithCredentials, setup?.signal);
  };
  try {
    return setupTimeoutSeconds === undefined
      ? await inspectIn()
      : await boundedBySetupTimeout(
          { seconds: setupTimeoutSeconds, what: 'the trial merge' },
          inspectIn,
        );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    tokenFile.remove();
  }
};
