import { Hono } from 'hono';
import type { Store } from '@forge/shared';
import { assetPath } from './assets.ts';
import type { TranscriptSource } from './transcript.ts';
import { renderDetail, renderList, renderWork } from './views.ts';
import type { AssetHrefs } from './views.ts';

export interface AppOptions {
  store: Store;
  transcripts: TranscriptSource;
  css: string;
  logo: string;
}

export const createApp = ({ store, transcripts, css, logo }: AppOptions): Hono => {
  const app = new Hono();
  const assets: AssetHrefs = {
    stylesheet: assetPath('dashboard', 'css', css),
    logo: assetPath('logo', 'svg', logo),
  };

  const serveImmutable = (href: string, body: string, contentType: string): void => {
    app.get(href, (c) => {
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
      return c.body(body, 200, { 'Content-Type': contentType });
    });
  };

  serveImmutable(assets.stylesheet, css, 'text/css; charset=utf-8');
  serveImmutable(assets.logo, logo, 'image/svg+xml; charset=utf-8');

  app.get('/', (c) => c.html(renderList(store.listRuns(), assets)));

  app.get('/work', (c) => c.html(renderWork(store.listFrontier(), assets)));

  app.get('/runs/:id', (c) => {
    const run = store.getRun(c.req.param('id'));
    if (run === undefined) return c.notFound();
    const events =
      run.transcriptRef === null ? [] : transcripts.read(run.transcriptRef);
    return c.html(renderDetail(run, events, assets));
  });

  return app;
};
