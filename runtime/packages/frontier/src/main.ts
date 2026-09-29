import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { queryFrontier, Store, type Fetch } from '@forge/shared';
import type { FrontierConfig } from './config.ts';

export const main = async (
  argv: string[],
  env: NodeJS.ProcessEnv,
  fetch: Fetch,
): Promise<number> => {
  if (argv[0] !== 'sync') {
    throw new Error('usage: forge-frontier sync');
  }

  const configPath = env.FORGE_RUNTIME_CONFIG;
  if (configPath === undefined) {
    throw new Error('FORGE_RUNTIME_CONFIG is not set');
  }
  const stateDir = env.FORGE_STATE_DIR;
  if (stateDir === undefined) {
    throw new Error('FORGE_STATE_DIR is not set');
  }
  const token = env.GITHUB_TOKEN;
  const poll =
    token === undefined || token === ''
      ? () => Promise.reject(new Error('GitHub token missing'))
      : (github: string) => queryFrontier(fetch, token, github);

  const config = JSON.parse(readFileSync(configPath, 'utf8')) as FrontierConfig;
  const store = Store.open(join(stateDir, 'forge.db'));

  try {
    store.pruneFrontier(Object.keys(config.repositories));
    let failed = false;
    for (const [name, { github }] of Object.entries(config.repositories)) {
      try {
        const tickets = await poll(github);
        store.replaceFrontier({
          repository: name,
          github,
          polledAt: new Date().toISOString(),
          tickets,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`${name}: ${message}`);
        store.recordFrontierError({
          repository: name,
          github,
          message,
          failedAt: new Date().toISOString(),
        });
        failed = true;
      }
    }
    return failed ? 1 : 0;
  } finally {
    store.close();
  }
};

if (import.meta.filename === process.argv[1]) {
  main(process.argv.slice(2), process.env, globalThis.fetch)
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
