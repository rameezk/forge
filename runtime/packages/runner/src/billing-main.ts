import { join } from 'node:path';
import { Store } from '@forge/shared';
import { settleGenerations } from './billing.ts';
import { OPENROUTER_API, openRouterLookUp } from './openrouter.ts';

const HEADER_VALUE = /^[\x21-\x7e]+$/;

const baseUrlOf = (env: NodeJS.ProcessEnv): URL => {
  const baseUrl = env.OPENROUTER_BASE_URL ?? OPENROUTER_API;
  const url = URL.parse(baseUrl);
  if (url === null || !['https:', 'http:'].includes(url.protocol)) {
    throw new Error(
      `OPENROUTER_BASE_URL is not an http(s) URL: ${JSON.stringify(baseUrl)}`,
    );
  }
  return url;
};

const apiKeyOf = (env: NodeJS.ProcessEnv): string => {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (apiKey === undefined || apiKey === '') {
    throw new Error('OPENROUTER_API_KEY is not set');
  }
  if (!HEADER_VALUE.test(apiKey)) {
    throw new Error('OPENROUTER_API_KEY is malformed');
  }
  return apiKey;
};

export const main = async (env: NodeJS.ProcessEnv): Promise<number> => {
  const stateDir = env.FORGE_STATE_DIR;
  if (stateDir === undefined) {
    throw new Error('FORGE_STATE_DIR is not set');
  }
  const lookUp = openRouterLookUp(baseUrlOf(env), apiKeyOf(env));

  const store = Store.open(join(stateDir, 'forge.db'));
  try {
    await settleGenerations({
      store,
      lookUp,
      now: () => new Date().toISOString(),
      log: (line) => process.stderr.write(`${line}\n`),
    });
    return 0;
  } finally {
    store.close();
  }
};

if (import.meta.filename === process.argv[1]) {
  main(process.env)
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
