import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Store } from '@forge/shared';
import { createApp, type AppOptions } from './app.ts';
import { resolveServeConfig } from './config.ts';
import { readStylesheet } from './assets.ts';
import { FileTranscriptSource } from './transcript.ts';

export const createDashboard = (
  stateDir: string,
  store: Store,
  options: Pick<AppOptions, 'checkIntervalMs'> = {},
): ReturnType<typeof createApp> =>
  createApp({
    store,
    transcripts: new FileTranscriptSource(join(stateDir, 'transcripts')),
    css: readStylesheet(fileURLToPath(new URL('../dist/dashboard.css', import.meta.url))),
    logo: readFileSync(new URL('../assets/logo.svg', import.meta.url), 'utf8'),
    idiomorph: readFileSync(new URL(import.meta.resolve('idiomorph/dist/idiomorph.min.js')), 'utf8'),
    client: readFileSync(new URL('../assets/live.js', import.meta.url), 'utf8'),
    ...options,
  });

export const main = (env: NodeJS.ProcessEnv): void => {
  const { stateDir, hostname, port } = resolveServeConfig(env);

  const app = createDashboard(stateDir, Store.open(join(stateDir, 'forge.db')));

  serve({ fetch: app.fetch, hostname, port }, (info) => {
    console.log(`forge dashboard listening on http://${info.address}:${info.port}`);
  });
};

if (import.meta.filename === process.argv[1]) {
  main(process.env);
}
