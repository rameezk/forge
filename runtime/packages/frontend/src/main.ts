import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Store } from '@forge/shared';
import { createApp } from './app.ts';
import { resolveServeConfig } from './config.ts';
import { FileTranscriptSource } from './transcript.ts';

export const main = (env: NodeJS.ProcessEnv): void => {
  const { stateDir, hostname, port } = resolveServeConfig(env);

  const store = Store.open(join(stateDir, 'forge.db'));
  const transcripts = new FileTranscriptSource(join(stateDir, 'transcripts'));
  const app = createApp({ store, transcripts });

  serve({ fetch: app.fetch, hostname, port }, (info) => {
    console.log(`forge dashboard listening on http://${info.address}:${info.port}`);
  });
};

if (import.meta.filename === process.argv[1]) {
  main(process.env);
}
