import { isAbsolute } from 'node:path';
import type { Sandbox } from './sandbox.ts';

export const absolutePath = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (value === undefined || !isAbsolute(value)) {
    throw new Error(`${name} is not set to an absolute path`);
  }
  return value;
};

export const stateDirOf = (env: NodeJS.ProcessEnv): string => {
  const stateDir = env.FORGE_STATE_DIR;
  if (stateDir === undefined) {
    throw new Error('FORGE_STATE_DIR is not set');
  }
  return stateDir;
};

const SYSTEM_VARIABLES = ['PATH', 'LANG', 'LOCALE_ARCHIVE', 'TZDIR'];

export const picked = (
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
