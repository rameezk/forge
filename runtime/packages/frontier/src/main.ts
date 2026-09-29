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
  if (token === undefined || token === '') {
    throw new Error('GITHUB_TOKEN is not set');
  }

  const config = JSON.parse(readFileSync(configPath, 'utf8')) as FrontierConfig;
  const store = Store.open(join(stateDir, 'forge.db'));

  try {
    for (const [name, { github }] of Object.entries(config.repositories)) {
      const tickets = await queryFrontier(fetch, token, github);
      store.replaceFrontier({
        repository: name,
        github,
        polledAt: new Date().toISOString(),
        tickets,
      });
    }
    return 0;
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
