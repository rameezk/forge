import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Store } from '@forge/shared';
import { assetPath } from './assets.ts';
import type { TranscriptSource } from './transcript.ts';
import { isSettled, NAV_PAGES, renderDetail, renderList, renderWork, type AssetHrefs } from './views.ts';

const DETAIL_PAGE = /^\/runs\/([^/]+)$/;

const runOfDetailPage = (page: string): string | undefined => {
  const encoded = DETAIL_PAGE.exec(page)?.[1];
  if (encoded === undefined) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
};

interface Watch {
  version: () => string;
  finished: () => boolean;
}

export interface AppOptions {
  store: Store;
  transcripts: TranscriptSource;
  css: string;
  logo: string;
  idiomorph: string;
  client: string;
  checkIntervalMs?: number;
}

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

  const transcriptSize = (runId: string): number | undefined => {
    const ref = store.getRun(runId)?.transcriptRef ?? null;
    return ref === null ? undefined : transcripts.size(ref);
  };

  const watch = (page: string | undefined): Watch | undefined => {
    if (page === undefined) return undefined;
    if (NAV_PAGES.has(page)) return { version: () => String(store.dataVersion()), finished: () => false };
    const runId = runOfDetailPage(page);
    if (runId === undefined || store.getRun(runId) === undefined) return undefined;
    return {
      version: () => JSON.stringify([store.dataVersion(), transcriptSize(runId)]),
      finished: () => {
        const run = store.getRun(runId);
        return run !== undefined && isSettled(run);
      },
    };
  };

  app.get('/events', (c) => {
    const page = c.req.query('page');
    const watched = watch(page);
    if (page === undefined || watched === undefined) return c.notFound();
    return streamSSE(c, async (stream) => {
      const signal = () => stream.writeSSE({ event: 'change', data: page });
      let version = watched.version();
      let sent = await renderedHash(page);
      await signal();
      for (;;) {
        if (watched.finished()) {
          await stream.writeSSE({ event: 'done', data: page });
          return;
        }
        await stream.sleep(checkIntervalMs);
        if (stream.aborted) return;
        const current = watched.version();
        if (current === version) continue;
        version = current;
        const hash = await renderedHash(page);
        if (hash === sent) continue;
        sent = hash;
        await signal();
      }
    });
  });

  return app;
};
