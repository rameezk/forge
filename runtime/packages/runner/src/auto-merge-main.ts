import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cachedTokens, errorMessage, githubAppFromEnv, Store, type Fetch } from '@forge/shared';
import { autoMergePullRequests } from './auto-merge.ts';
import type { RuntimeConfig } from './config.ts';

const memoized = <T>(read: () => Promise<T>): (() => Promise<T>) => {
  let value: Promise<T> | undefined;
  return () => {
    value ??= read();
    return value;
  };
};

export const main = async (
  env: NodeJS.ProcessEnv,
  fetch: Fetch,
  now: () => string = () => new Date().toISOString(),
  random: () => number = () => randomInt(2 ** 32) / 2 ** 32,
): Promise<number> => {
  const stateDir = env.FORGE_STATE_DIR;
  if (stateDir === undefined) {
    throw new Error('FORGE_STATE_DIR is not set');
  }
  const configPath = env.FORGE_RUNTIME_CONFIG;
  if (configPath === undefined) {
    throw new Error('FORGE_RUNTIME_CONFIG is not set');
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as RuntimeConfig;
  const repositories = Object.fromEntries(
    Object.entries(config.repositories ?? {})
      .filter(([, { autoMerge }]) => autoMerge === true),
  );
  if (Object.keys(repositories).length === 0) return 0;

  const app = githubAppFromEnv(env, fetch);
  const store = Store.open(join(stateDir, 'forge.db'));
  try {
    const merged = await autoMergePullRequests({
      store,
      fetch,
      tokens: cachedTokens(app),
      reviewerLogin: memoized(() => app.login()),
      repositories,
      random,
      now,
      log: (line) => process.stderr.write(`${line}\n`),
    });
    return merged ? 0 : 1;
  } finally {
    store.close();
  }
};

if (import.meta.filename === process.argv[1]) {
  main(process.env, globalThis.fetch)
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(errorMessage(error));
      process.exit(1);
    });
}
