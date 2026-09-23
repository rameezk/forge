import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Store } from '@forge/shared';
import { createApp } from './app.ts';
import { FileTranscriptSource } from './transcript.ts';

const LOOPBACK = '127.0.0.1';
const DEFAULT_PORT = 7787;

export const main = (env: NodeJS.ProcessEnv): void => {
  const stateDir = env.FORGE_STATE_DIR;
  if (stateDir === undefined) {
    throw new Error('FORGE_STATE_DIR is not set');
  }
  const hostname = env.FORGE_FRONTEND_HOST ?? LOOPBACK;
  const port =
    env.FORGE_FRONTEND_PORT === undefined
      ? DEFAULT_PORT
      : Number(env.FORGE_FRONTEND_PORT);

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
