import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Store } from '@forge/shared';
import { assetPath } from './assets.ts';
import type { TranscriptSource } from './transcript.ts';
import { renderDetail, renderList, renderWork, type AssetHrefs } from './views.ts';

export interface AppOptions {
  store: Store;
  transcripts: TranscriptSource;
  css: string;
  logo: string;
  idiomorph: string;
  client: string;
  checkIntervalMs?: number;
}

const LIVE_PAGES = new Set(['/', '/work']);

export const createApp = ({
  store,
  transcripts,
  css,
  logo,
  idiomorph,
  client,
  checkIntervalMs = 1000,
}: AppOptions): Hono => {
  const app = new Hono();
  const assets: AssetHrefs = {
    stylesheet: assetPath('dashboard', 'css', css),
    logo: assetPath('logo', 'svg', logo),
    idiomorph: assetPath('idiomorph', 'js', idiomorph),
    client: assetPath('live', 'js', client),
  };

  const serveImmutable = (href: string, body: string, contentType: string): void => {
    app.get(href, (c) => {
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
      return c.body(body, 200, { 'Content-Type': contentType });
    });
  };

  serveImmutable(assets.stylesheet, css, 'text/css; charset=utf-8');
  serveImmutable(assets.logo, logo, 'image/svg+xml; charset=utf-8');
  serveImmutable(assets.idiomorph, idiomorph, 'text/javascript; charset=utf-8');
  serveImmutable(assets.client, client, 'text/javascript; charset=utf-8');

  app.get('/', (c) => c.html(renderList(store.listRuns(), assets)));

  app.get('/work', (c) =>
    c.html(renderWork(store.listFrontier(), store.listDispatches(new Date().toISOString()), assets)),
  );

  app.get('/runs/:id', (c) => {
    const run = store.getRun(c.req.param('id'));
    if (run === undefined) return c.notFound();
    const events =
      run.transcriptRef === null ? [] : transcripts.read(run.transcriptRef);
    return c.html(renderDetail(run, events, store.listGenerations(run.id), assets));
  });

  const renderedHash = async (page: string): Promise<string> =>
    createHash('sha256')
      .update(await (await app.request(page)).text())
      .digest('hex');

  app.get('/events', (c) => {
    const page = c.req.query('page');
    if (page === undefined || !LIVE_PAGES.has(page)) return c.notFound();
    return streamSSE(c, async (stream) => {
      const signal = (hash: string) => stream.writeSSE({ event: 'change', data: hash, id: hash });
      let version = store.dataVersion();
      let sent = await renderedHash(page);
      const seen = c.req.header('Last-Event-ID');
      if (seen === sent) {
        await stream.write(`id: ${sent}\n\n`);
      } else {
        await signal(sent);
      }
      for (;;) {
        await stream.sleep(checkIntervalMs);
        if (stream.aborted) return;
        const current = store.dataVersion();
        if (current === version) continue;
        version = current;
        const hash = await renderedHash(page);
        if (hash === sent) continue;
        sent = hash;
        await signal(hash);
      }
    });
  });

  return app;
};
