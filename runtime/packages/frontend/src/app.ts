import { Hono } from 'hono';
import type { Store } from '@forge/shared';
import type { TranscriptSource } from './transcript.ts';
import { renderDetail, renderList } from './views.ts';

export interface AppOptions {
  store: Store;
  transcripts: TranscriptSource;
}

export const createApp = ({ store, transcripts }: AppOptions): Hono => {
  const app = new Hono();

  app.get('/', (c) => c.html(renderList(store.listRuns())));

  app.get('/runs/:id', (c) => {
    const run = store.getRun(c.req.param('id'));
    if (run === undefined) return c.notFound();
    const events =
      run.transcriptRef === null ? [] : transcripts.read(run.transcriptRef);
    return c.html(renderDetail(run, events));
  });

  return app;
};
