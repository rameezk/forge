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
import { gradeUrgency, URGENCY_QUESTION } from './urgency.ts';
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
  const managed = Object.entries(config.repositories ?? {});
  const graded = Object.fromEntries(
    managed.filter(([, { grading }]) => grading === true).map(([name, { github }]) => [name, github]),
  );
  const model = config.grading?.model;
  if (model === undefined) {
    if (Object.keys(graded).length > 0) {
      throw new Error('grading is on for a repository but forge.runtime.grading.model is not set');
    }
    return 0;
  }
  if (managed.length === 0) return 0;
  const url = decisionsUrl(openRouterBaseUrl(env));
  const apiKey = apiKeyOf(env);
  const threshold = config.grading?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const tokens = installationTokens(env, fetch);
  const now = (): string => new Date().toISOString();
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };

  const store = Store.open(join(stateDir, 'forge.db'));
  try {
    const pullRequestsGraded =
      Object.keys(graded).length === 0 ||
      (await gradePullRequests({
        store,
        fetch,
        tokens,
        decide: jevDecides(url, apiKey, model, globalThis.fetch),
        repositories: graded,
        model,
        threshold,
        now,
        log,
      }));
    const urgencyGraded = await gradeUrgency({
      urgency: store.urgency,
      fetch,
      tokens,
      decide: jevDecides(url, apiKey, model, globalThis.fetch, URGENCY_QUESTION),
      repositories: Object.fromEntries(
        managed.map(([name, { github, description }]) => [
          name,
          { github, description: description ?? null },
        ]),
      ),
      model,
      threshold,
      now,
      log,
    });
    return pullRequestsGraded && urgencyGraded ? 0 : 1;
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
