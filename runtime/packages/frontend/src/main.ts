import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Store } from '@forge/shared';
import { createApp } from './app.ts';
import { resolveServeConfig } from './config.ts';
import { readStylesheet } from './stylesheet.ts';
import { FileTranscriptSource } from './transcript.ts';

export const main = (env: NodeJS.ProcessEnv): void => {
  const { stateDir, hostname, port } = resolveServeConfig(env);

  const store = Store.open(join(stateDir, 'forge.db'));
  const transcripts = new FileTranscriptSource(join(stateDir, 'transcripts'));
  const css = readStylesheet(fileURLToPath(new URL('../dist/dashboard.css', import.meta.url)));
  const app = createApp({ store, transcripts, css });

  serve({ fetch: app.fetch, hostname, port }, (info) => {
    console.log(`forge dashboard listening on http://${info.address}:${info.port}`);
  });
};

if (import.meta.filename === process.argv[1]) {
  main(process.env);
}
