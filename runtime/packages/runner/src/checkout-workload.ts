import { join } from 'node:path';
import { errorMessage, type GithubApp, type RunTicket } from '@forge/shared';
import type { GitIdentity, RuntimeConfig } from './config.ts';
import { cloneCheckout, headCommit, loadPiSkills, resolveCheckout } from './checkout.ts';
import { enterDevShell } from './devshell.ts';
import { gitEnvironment } from './git.ts';
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
  branch,
  instruction,
  app,
  gitEnv,
  identity,
  ticket,
  runId,
}: {
  env: NodeJS.ProcessEnv;
  config: RuntimeConfig;
  worker: Worker;
  github: string;
  branch?: string;
  instruction?: string;
  app: GithubApp;
  gitEnv: Record<string, string>;
  identity: GitIdentity;
  ticket?: RunTicket;
  runId: string;
}): Promise<LaunchResult> => {
  const loadSkills = await loadPiSkills(absolutePath(env, 'FORGE_PI_PACKAGE'));
  const nixSystem = nixSystemOf(env);
  const hostEnv = withoutCredentials(env);
  const redactions: string[] = [];
  const minted = await app.mint(github, 'workload');
  const tokenFile = GithubTokenFile.create(
    join(stateDirOf(env), 'credentials'),
    runId,
    minted.token,
    redactions,
  );
  const stopRefreshing = keepFresh(
    tokenFile,
    minted,
    () => app.mint(github, 'workload'),
    (error) =>
      console.error(`could not refresh the workload's GitHub token: ${errorMessage(error)}`),
  );
  const cloneEnv = { ...hostEnv, ...tokenFile.environment, ...gitEnv };
  return launchWorkload({
    config,
    worker,
    env,
    harnessEnv: { ...tokenFile.environment, ...gitEnvironment({}, identity) },
    secrets: () => redactions,
    ...(ticket === undefined ? {} : { ticket }),
    runId,
    openWorkspace: async (workDir) => {
      await cloneCheckout(github, workDir, cloneEnv, branch);
      const baseCommit = await headCommit(workDir, { ...hostEnv, ...gitEnv });
      const checkout = resolveCheckout(workDir, loadSkills);
      const devShell = await enterDevShell({
        sandbox: sandboxOf(env),
        system: nixSystem,
        root: checkout.root,
        env: systemEnvironment(env),
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
