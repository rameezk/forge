import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  isHeaderValue,
  parseTranscriptLines,
  Store,
  type HarnessEvent,
} from '@forge/shared';
import { settleGenerations } from './billing.ts';
import { openRouterBaseUrl, openRouterLookUp } from './openrouter.ts';

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

export const main = async (env: NodeJS.ProcessEnv): Promise<number> => {
  const stateDir = env.FORGE_STATE_DIR;
  if (stateDir === undefined) {
    throw new Error('FORGE_STATE_DIR is not set');
  }
  const lookUp = openRouterLookUp(openRouterBaseUrl(env), apiKeyOf(env));

  const transcriptsDir = join(stateDir, 'transcripts');
  const readTranscript = (ref: string): HarnessEvent[] | null => {
    const path = resolve(transcriptsDir, ref);
    if (!path.startsWith(`${resolve(transcriptsDir)}${sep}`)) {
      throw new Error(`transcript ref ${JSON.stringify(ref)} is outside the transcripts directory`);
    }
    let contents: string;
    try {
      contents = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
    return parseTranscriptLines(contents);
  };

  const store = Store.open(join(stateDir, 'forge.db'));
  try {
    await settleGenerations({
      store,
      lookUp,
      readTranscript,
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
