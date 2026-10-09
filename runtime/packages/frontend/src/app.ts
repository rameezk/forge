import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { rawEventsRef, requestRecordRef, UNKNOWN_COHORT, type InsightsFilter, type RunRecord, type Store } from '@forge/shared';
import { assetPath } from './assets.ts';
import { readRequestRecord } from './request-record.ts';
import type { TranscriptSource } from './transcript.ts';
import { isSettled, NAV_PAGES, renderCohortPage, renderDetail, renderInsights, renderList, renderTicketAttempts, renderUnknownCohortPage, renderWork, type AssetHrefs, type Downloads } from './views.ts';

const TICKET_NUMBER = /^[1-9]\d*$/;

const ATTEMPTS_PAGE = /^\/tickets\/[^/]+\/[1-9]\d*$/;

const COHORT_PAGE = new RegExp(`^/cohorts/(?:${UNKNOWN_COHORT}|[0-9a-f]{64})(?:\\?.*)?$`);

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

interface Check {
  version: string;
  finished: boolean;
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

  app.get('/', (c) => c.html(renderList(store.listRuns(), store.listPriceEquivalents(), assets)));

  app.get('/work', (c) =>
    c.html(renderWork(store.listFrontier(), store.listDispatches(new Date().toISOString()), store.attemptedTickets(), assets)),
  );

  const DATE = /^\d{4}-\d{2}-\d{2}$/;

  const filterOf = (query: Record<string, string>): InsightsFilter => ({
    includeManual: query['manual'] === '1',
    ...(query['worker'] ? { worker: query['worker'] } : {}),
    ...(query['repository'] ? { repository: query['repository'] } : {}),
    ...(DATE.test(query['from'] ?? '') ? { from: query['from']! } : {}),
    ...(DATE.test(query['to'] ?? '') ? { to: query['to']! } : {}),
  });

  app.get('/insights', (c) => {
    const filter = filterOf(c.req.query());
    return c.html(renderInsights(store.listCohorts(filter), store.listPoints(filter), store.listProviderShares(filter), filter, store.insightsOptions(), assets));
  });

  app.get(`/cohorts/${UNKNOWN_COHORT}`, (c) => (store.hasUnknownConfigRuns() ? c.html(renderUnknownCohortPage(assets)) : c.notFound()));

  app.get('/cohorts/:hash', (c) => {
    const hash = c.req.param('hash');
    const fingerprint = store.getCohortFingerprint(hash);
    if (fingerprint === null) return c.notFound();
    const againstHash = c.req.query('against') ?? '';
    const against = againstHash === hash ? null : store.getCohortFingerprint(againstHash);
    return c.html(renderCohortPage({ hash, fingerprint }, against === null ? null : { hash: againstHash, fingerprint: against }, store.listCohortFingerprints(), assets));
  });

  app.get('/tickets/:repository/:number', (c) => {
    const number = Number(c.req.param('number'));
    if (!TICKET_NUMBER.test(c.req.param('number')) || !Number.isSafeInteger(number)) return c.notFound();
    const ticket = { repository: c.req.param('repository'), number };
    return c.html(renderTicketAttempts(ticket, store.listAttempts(ticket), assets));
  });

  const downloadable = (ref: string | null): ref is string =>
    ref !== null && (transcripts.size(ref) ?? 0) > 0;

  const downloadsOf = (run: RunRecord): Downloads => ({
    transcript: downloadable(run.transcriptRef),
    rawEvents: downloadable(rawEventsRef(run.id)),
    requestRecord: downloadable(requestRecordRef(run.id)),
  });

  app.get('/runs/:id', (c) => {
    const run = store.getRun(c.req.param('id'));
    if (run === undefined) return c.notFound();
    const events =
      run.transcriptRef === null ? [] : transcripts.read(run.transcriptRef);
    const record = readRequestRecord((visit) => transcripts.scanRecords(requestRecordRef(run.id), visit));
    return c.html(renderDetail(run, events, record, store.listGenerations(run.id), store.pullRequestOfRun(run.id), store.listSkillLoads(run.id), downloadsOf(run), store.getFingerprint(run.id), assets));
  });

  const serveDownload = (path: `/runs/:id/${string}`, refOf: (run: RunRecord) => string | null): void => {
    app.get(path, (c) => {
      const run = store.getRun(c.req.param('id'));
      const ref = run === undefined ? null : refOf(run);
      if (!downloadable(ref)) return c.notFound();
      return c.body(transcripts.stream(ref), 200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': `attachment; filename="${ref}"`,
        'X-Content-Type-Options': 'nosniff',
      });
    });
  };

  serveDownload('/runs/:id/transcript', (run) => run.transcriptRef);
  serveDownload('/runs/:id/raw-events', (run) => rawEventsRef(run.id));
  serveDownload('/runs/:id/request-record', (run) => requestRecordRef(run.id));

  const renderedHash = async (page: string): Promise<string> =>
    createHash('sha256')
      .update(await (await app.request(page)).text())
      .digest('hex');

  const watch = (page: string | undefined): (() => Check) | undefined => {
    if (page === undefined) return undefined;
    if (NAV_PAGES.has(page.split('?')[0]!) || ATTEMPTS_PAGE.test(page) || COHORT_PAGE.test(page)) return () => ({ version: String(store.dataVersion()), finished: false });
    const runId = runOfDetailPage(page);
    if (runId === undefined || store.getRun(runId) === undefined) return undefined;
    return () => {
      const run = store.getRun(runId);
      const ref = run?.transcriptRef ?? null;
      return {
        version: JSON.stringify([store.dataVersion(), ref === null ? undefined : transcripts.size(ref)]),
        finished: run !== undefined && isSettled(run),
      };
    };
  };

  app.get('/events', (c) => {
    const page = c.req.query('page');
    const check = watch(page);
    if (page === undefined || check === undefined) return c.notFound();
    return streamSSE(c, async (stream) => {
      const signal = () => stream.writeSSE({ event: 'change', data: page });
      let checked = check();
      let sent = await renderedHash(page);
      await signal();
      while (!checked.finished) {
        await stream.sleep(checkIntervalMs);
        if (stream.aborted) return;
        const current = check();
        const moved = current.version !== checked.version;
        checked = current;
        if (!moved) continue;
        const hash = await renderedHash(page);
        if (hash === sent) continue;
        sent = hash;
        await signal();
      }
      await stream.writeSSE({ event: 'done', data: page });
    });
  });

  return app;
};
