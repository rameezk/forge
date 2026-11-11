import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage, installationTokens, isHeaderValue, Store, type Fetch } from '@forge/shared';
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  decisionsUrl,
  gradePullRequests,
  jevDecides,
} from './grading.ts';
import { openRouterBaseUrl } from './openrouter.ts';
import type { RuntimeConfig } from './config.ts';

const apiKeyOf = (env: NodeJS.ProcessEnv): string => {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (apiKey === undefined || apiKey === '') {
    throw new Error('OPENROUTER_API_KEY is not set');
  }
  if (!isHeaderValue(apiKey)) {
    throw new Error('OPENROUTER_API_KEY is malformed');
  }
  return apiKey;
};

export const main = async (env: NodeJS.ProcessEnv, fetch: Fetch): Promise<number> => {
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
      .filter(([, { grading }]) => grading === true)
      .map(([name, { github }]) => [name, github]),
  );
  if (Object.keys(repositories).length === 0) return 0;
  const model = config.grading?.model;
  if (model === undefined) {
    throw new Error('grading is on for a repository but forge.runtime.grading.model is not set');
  }
  const decide = jevDecides(decisionsUrl(openRouterBaseUrl(env)), apiKeyOf(env), model, globalThis.fetch);

  const store = Store.open(join(stateDir, 'forge.db'));
  try {
    const graded = await gradePullRequests({
      store,
      fetch,
      tokens: installationTokens(env, fetch),
      decide,
      repositories,
      model,
      threshold: config.grading?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
      now: () => new Date().toISOString(),
      log: (line) => process.stderr.write(`${line}\n`),
    });
    return graded ? 0 : 1;
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
