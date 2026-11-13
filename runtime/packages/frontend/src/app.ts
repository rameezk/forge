import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { aggregateRisk, INSIGHT_KIND_FILTERS, noFailures, rawEventsRef, requestRecordRef, ticketKey, UNKNOWN_COHORT, type InsightsFilter, type RunPullRequestWorkload, type RunRecord, type Store } from '@forge/shared';
import { assetPath } from './assets.ts';
import { readRequestRecord } from './request-record.ts';
import type { TranscriptSource } from './transcript.ts';
import { renderTicketAttempts } from './views/attempts.ts';
import { renderBoard } from './views/board.ts';
import { parseTranscriptShow, renderFullTranscript } from './views/full-transcript.ts';
import { DEFAULT_INSIGHTS_TAB, defaultKindOf, INSIGHTS_TABS, renderCohortPage, renderInsights, renderRisk, renderUnknownCohortPage, type InsightsQuery } from './views/insights.ts';
import { isSettled, renderDetail, type Downloads } from './views/run.ts';
import { NAV_PAGES, type AssetHrefs, type Display } from './views/shared.ts';
import type { DeployStatus } from './deploy-status.ts';
import { dayRange, parseDay } from './days.ts';
import { parsePage, parseWorkloadFilter } from './workload-filter.ts';
import { renderList } from './views/workloads.ts';

const TICKET_NUMBER = /^[1-9]\d*$/;

const ATTEMPTS_PAGE = /^\/tickets\/[^/]+\/[1-9]\d*$/;

const COHORT_PAGE = new RegExp(`^/cohorts/(?:${UNKNOWN_COHORT}|[0-9a-f]{64})(?:\\?.*)?$`);

const VERSION_ATTRIBUTE = / data-version="[^"]*"/;

const DETAIL_PAGE = /^\/runs\/([^/?]+)(?:\/transcript)?(?:\?.*)?$/;

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
  timeZone?: string;
  clock?: () => Date;
  checkIntervalMs?: number;
  maxConcurrent?: number;
  maxOpenPullRequests?: number | null;
  gradingRepositories?: readonly string[];
  deployStatus?: () => DeployStatus | null;
}

export const createApp = ({
  store,
  transcripts,
  css,
  logo,
  idiomorph,
  client,
  timeZone = 'UTC',
  clock = () => new Date(),
  checkIntervalMs = 1000,
  maxConcurrent = 1,
  maxOpenPullRequests = 5,
  gradingRepositories = [],
  deployStatus = () => null,
}: AppOptions): Hono => {
  const app = new Hono();
  const assets: AssetHrefs = {
    stylesheet: assetPath('dashboard', 'css', css),
    logo: assetPath('logo', 'svg', logo),
    idiomorph: assetPath('idiomorph', 'js', idiomorph),
    client: assetPath('live', 'js', client),
  };
  const display: Display = { assets, timeZone };

  const watch = (page: string | undefined): (() => Check) | undefined => {
    if (page === undefined) return undefined;
    if (NAV_PAGES.has(page.split('?')[0]!) || ATTEMPTS_PAGE.test(page) || COHORT_PAGE.test(page)) return () => ({ version: JSON.stringify([store.dataVersion(), deployStatus()]), finished: false });
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

  const displayOf = (c: Context): Display => {
    const { pathname, search } = new URL(c.req.url);
    const version = watch(pathname + search)?.().version;
    const deploy = deployStatus();
    return version === undefined ? { ...display, deploy } : { ...display, version, deploy };
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

  app.get('/', (c) => {
    const shown = displayOf(c);
    const now = new Date().toISOString();
    const dispatches = store.listDispatches(now);
    const revisions = store.listRevisions(now);
    const conflictResolutions = store.listConflictResolutions(now);
    const runs = new Map<string, RunRecord>();
    for (const runId of [...dispatches, ...[...revisions, ...conflictResolutions].filter(({ state }) => state === 'running')].map(({ runId }) => runId)) {
      const run = runId === null ? undefined : store.getRun(runId);
      if (run !== undefined) runs.set(run.id, run);
    }
    return c.html(renderBoard(store.listFrontier(), dispatches, revisions, conflictResolutions, runs, store.attemptedTickets(), { running: store.liveWorkloads(now), limit: maxConcurrent }, { ...store.reviewSlotsTaken(now), limit: maxOpenPullRequests }, shown, c.req.query('group') === 'spec' ? 'spec' : 'none', deployStatus(), { repositories: new Set(gradingRepositories), grades: new Map(store.currentRiskGrades().map((grade) => [ticketKey(grade.repository, grade.number), grade])), attempts: new Map(store.currentGradingAttempts().map((attempt) => [ticketKey(attempt.repository, attempt.number), attempt])), costUsd: store.gradingCostUsd(), status: store.gradingStatus() }));
  });

  app.get('/work', (c) => c.redirect('/'));

  app.get('/runs', (c) => c.redirect(`/workloads${new URL(c.req.url).search}`));

  app.get('/workloads', (c) => {
    const shown = displayOf(c);
    const now = new Date().toISOString();
    const pullRequestWorkloads = new Map<string, RunPullRequestWorkload>([
      ...store.listRevisions(now).flatMap((workload): [string, RunPullRequestWorkload][] =>
        workload.runId === null ? [] : [[workload.runId, { kind: 'revision', workload }]],
      ),
      ...store.listConflictResolutions(now).flatMap((workload): [string, RunPullRequestWorkload][] =>
        workload.runId === null ? [] : [[workload.runId, { kind: 'conflict-resolution', workload }]],
      ),
    ]);
    const diagnoses = store.listDiagnoses(now);
    const categories = store.latestDiagnosisCategories(now);
    return c.html(renderList(store.listRuns(), parseWorkloadFilter(c.req.query()), parsePage(c.req.query()), store.listPriceEquivalents(), pullRequestWorkloads, store.mapRunDispatches(now), new Set(diagnoses.map(({ runId }) => runId)), categories, store.runCohorts(), shown, clock().getTime()));
  });

  const queryOf = (query: Record<string, string>): InsightsQuery => {
    const from = parseDay(query['from']);
    const to = parseDay(query['to']);
    const tab = INSIGHTS_TABS.find((candidate) => candidate === query['tab']) ?? DEFAULT_INSIGHTS_TAB;
    return {
      tab,
      kind: INSIGHT_KIND_FILTERS.find((kind) => kind === query['kind']) ?? defaultKindOf(tab),
      includeManual: tab !== 'failures' && query['manual'] === '1',
      ...(query['worker'] ? { worker: query['worker'] } : {}),
      ...(query['repository'] ? { repository: query['repository'] } : {}),
      ...(query['cohort'] ? { cohort: query['cohort'] } : {}),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    };
  };

  const filterOf = ({ from, to, tab: _tab, cohort: _cohort, ...rest }: InsightsQuery): InsightsFilter => {
    const { startedFrom, startedBefore } = dayRange(from, to, timeZone);
    return {
      ...rest,
      ...(startedFrom === undefined ? {} : { startedFrom: new Date(startedFrom).toISOString() }),
      ...(startedBefore === undefined ? {} : { startedBefore: new Date(startedBefore).toISOString() }),
    };
  };

  app.get('/insights', (c) => {
    const shown = displayOf(c);
    const query = queryOf(c.req.query());
    if (query.tab === 'risk') {
      const options = store.riskOptions();
      const fingerprint = query.cohort ?? options.cohorts[0];
      const { startedFrom, startedBefore } = dayRange(query.from, query.to, timeZone);
      const grades = fingerprint === undefined ? [] : store.listRiskGrades({
        fingerprint,
        ...(query.repository === undefined ? {} : { repository: query.repository }),
        ...(startedFrom === undefined ? {} : { gradedFrom: new Date(startedFrom).toISOString() }),
        ...(startedBefore === undefined ? {} : { gradedBefore: new Date(startedBefore).toISOString() }),
      });
      return c.html(renderRisk(aggregateRisk(grades), { ...query, ...(fingerprint === undefined ? {} : { cohort: fingerprint }) }, options, shown));
    }
    const filter = filterOf(query);
    return c.html(renderInsights(store.listCohorts(filter), store.listPoints(filter), store.listProviderShares(filter), query, store.insightsOptions(), shown));
  });

  app.get(`/cohorts/${UNKNOWN_COHORT}`, (c) => {
    const shown = displayOf(c);
    return store.hasUnknownConfigRuns() ? c.html(renderUnknownCohortPage(shown)) : c.notFound();
  });

  app.get('/cohorts/:hash', (c) => {
    const shown = displayOf(c);
    const hash = c.req.param('hash');
    const fingerprint = store.getCohortFingerprint(hash);
    if (fingerprint === null) return c.notFound();
    const againstHash = c.req.query('against') ?? '';
    const against = againstHash === hash ? null : store.getCohortFingerprint(againstHash);
    return c.html(renderCohortPage({ hash, fingerprint }, against === null ? null : { hash: againstHash, fingerprint: against }, store.listCohortFingerprints(), store.listCohorts({ kind: 'all', includeManual: false }).find((cohort) => cohort.hash === hash)?.failures ?? noFailures(), shown));
  });

  app.get('/tickets/:repository/:number', (c) => {
    const shown = displayOf(c);
    const number = Number(c.req.param('number'));
    if (!TICKET_NUMBER.test(c.req.param('number')) || !Number.isSafeInteger(number)) return c.notFound();
    const ticket = { repository: c.req.param('repository'), number };
    return c.html(renderTicketAttempts(ticket, store.listAttempts(ticket, new Date().toISOString()), shown));
  });

  const downloadable = (ref: string | null): ref is string =>
    ref !== null && (transcripts.size(ref) ?? 0) > 0;

  const downloadsOf = (run: RunRecord): Downloads => ({
    transcript: downloadable(run.transcriptRef),
    rawEvents: downloadable(rawEventsRef(run.id)),
    requestRecord: downloadable(requestRecordRef(run.id)),
  });

  app.get('/runs/:id', (c) => {
    const shown = displayOf(c);
    const run = store.getRun(c.req.param('id'));
    if (run === undefined) return c.notFound();
    const events =
      run.transcriptRef === null ? [] : transcripts.read(run.transcriptRef);
    const record = readRequestRecord((visit) => transcripts.scanRecords(requestRecordRef(run.id), visit));
    return c.html(renderDetail(run, events, record, store.listGenerations(run.id), store.pullRequestOfRun(run.id), store.pullRequestWorkloadOfRun(run.id, new Date().toISOString()), store.dispatchOfRun(run.id, new Date().toISOString()), store.listSkillLoads(run.id), downloadsOf(run), store.getFingerprint(run.id), store.diagnosesOf(run.id, new Date().toISOString()), store.diagnosisOfRun(run.id, new Date().toISOString()), shown));
  });

  app.get('/runs/:id/transcript', (c) => {
    const shown = displayOf(c);
    const run = store.getRun(c.req.param('id'));
    if (run === undefined) return c.notFound();
    const events = run.transcriptRef === null ? [] : transcripts.read(run.transcriptRef);
    return c.html(renderFullTranscript(run, events, store.listGenerations(run.id), store.listSkillLoads(run.id), parseTranscriptShow(c.req.query('show')), shown));
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

  serveDownload('/runs/:id/transcript.jsonl', (run) => run.transcriptRef);
  serveDownload('/runs/:id/raw-events', (run) => rawEventsRef(run.id));
  serveDownload('/runs/:id/request-record', (run) => requestRecordRef(run.id));

  const renderedHash = async (page: string): Promise<string> =>
    createHash('sha256')
      .update((await (await app.request(page)).text()).replace(VERSION_ATTRIBUTE, ''))
      .digest('hex');

  app.get('/events', (c) => {
    const page = c.req.query('page');
    const check = watch(page);
    if (page === undefined || check === undefined) return c.notFound();
    const renderedVersion = c.req.query('version');
    return streamSSE(c, async (stream) => {
      const signal = () => stream.writeSSE({ event: 'change', data: page });
      let checked = check();
      let sent = await renderedHash(page);
      if (checked.version !== renderedVersion) await signal();
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
