import { join } from 'node:path';
import type { RunTicket } from '@forge/shared';
import type { GitIdentity, RuntimeConfig } from './config.ts';
import { cloneCheckout, headCommit, loadPiSkills, resolveCheckout } from './checkout.ts';
import { enterDevShell } from './devshell.ts';
import { gitEnvironment } from './git.ts';
import { GithubTokenFile } from './github-token-file.ts';
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
  token,
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
  token: string;
  gitEnv: Record<string, string>;
  identity: GitIdentity;
  ticket?: RunTicket;
  runId: string;
}): Promise<LaunchResult> => {
  const loadSkills = await loadPiSkills(absolutePath(env, 'FORGE_PI_PACKAGE'));
  const nixSystem = nixSystemOf(env);
  const hostEnv = withoutCredentials(env);
  const redactions: string[] = [];
  const tokenFile = GithubTokenFile.create(
    join(stateDirOf(env), 'credentials'),
    runId,
    token,
    redactions,
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
  }).finally(() => tokenFile.remove());
};
