import { Hono } from 'hono';
import type { Store } from '@forge/shared';
import { stylesheetPath } from './stylesheet.ts';
import type { TranscriptSource } from './transcript.ts';
import { renderDetail, renderList, renderWork } from './views.ts';

export interface AppOptions {
  store: Store;
  transcripts: TranscriptSource;
  stylesheet: string;
}

export const createApp = ({ store, transcripts, stylesheet }: AppOptions): Hono => {
  const app = new Hono();
  const path = stylesheetPath(stylesheet);

  app.get(path, (c) => {
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    return c.body(stylesheet, 200, { 'Content-Type': 'text/css; charset=utf-8' });
  });

  app.get('/', (c) => c.html(renderList(store.listRuns(), path)));

  app.get('/work', (c) => c.html(renderWork(store.listFrontier(), path)));

  app.get('/runs/:id', (c) => {
    const run = store.getRun(c.req.param('id'));
    if (run === undefined) return c.notFound();
    const events =
      run.transcriptRef === null ? [] : transcripts.read(run.transcriptRef);
    return c.html(renderDetail(run, events, path));
  });

  return app;
};
