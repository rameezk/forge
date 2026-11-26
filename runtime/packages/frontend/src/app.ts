import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { aggregateRisk, autoMergeStatus, summarizeRisk, type DispatchOrder, type RepositoriesView, INSIGHT_KIND_FILTERS, noFailures, rawEventsRef, requestRecordRef, UNKNOWN_COHORT, type InsightsFilter, type RunPullRequestWorkload, type AutoMergeStatus, type RunRecord, type Store } from '@forge/shared';
import { mountApi } from './api.ts';
import { assetPath } from './assets.ts';
import { readRequestRecord } from './request-record.ts';
import type { TranscriptSource } from './transcript.ts';
import { renderTicketAttempts } from './views/attempts.ts';
import { boardPage, type BoardSettings } from './views/board.ts';
import { parseTranscriptShow, renderFullTranscript } from './views/full-transcript.ts';
import { DEFAULT_INSIGHTS_TAB, defaultKindOf, INSIGHTS_TABS, renderCohortPage, renderInsights, renderRisk, renderUnknownCohortPage, type InsightsQuery } from './views/insights.ts';
import { isSettled, renderDetail, type Downloads } from './views/run.ts';
import { NAV_PAGES, type AssetHrefs, type Display } from './views/shared.ts';
import type { DeployStatus } from './deploy-status.ts';
import { needsOperator, type GradingAttention } from './grading.ts';
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
  autoMergeRepositories?: readonly string[];
  dispatchOrder?: DispatchOrder;
  repositoryPriorities?: Readonly<Record<string, number>>;
  deployStatus?: () => DeployStatus | null;
  repositories?: RepositoriesView;
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
  autoMergeRepositories = [],
  dispatchOrder = 'oldest',
  repositoryPriorities = {},
  deployStatus = () => null,
  repositories = [],
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
    if (NAV_PAGES.has(page.split('?')[0]!) || ATTEMPTS_PAGE.test(page) || COHORT_PAGE.test(page)) return () => ({ version: JSON.stringify([store.dataVersion(), deployStatus(), escalatedGrading()]), finished: false });
    const runId = runOfDetailPage(page);
    if (runId === undefined || store.runs.getRun(runId) === undefined) return undefined;
    return () => {
      const run = store.runs.getRun(runId);
      const ref = run?.transcriptRef ?? null;
      return {
        version: JSON.stringify([store.dataVersion(), ref === null ? undefined : transcripts.size(ref)]),
        finished: run !== undefined && isSettled(run),
      };
    };
  };

  const gradingAttention = (): GradingAttention | null =>
    gradingRepositories.length === 0 ? null : { status: store.grades.gradingStatus(), now: clock().getTime() };

  const autoMergePause = (): AutoMergeStatus | null => {
    if (autoMergeRepositories.length === 0) return null;
    const status = autoMergeStatus(store);
    return status.state === 'paused' ? status : null;
  };

  const escalatedGrading = (): boolean => {
    const grading = gradingAttention();
    return grading !== null && needsOperator(grading) !== null;
  };

  const displayOf = (c: Context): Display => {
    const { pathname, search } = new URL(c.req.url);
    const version = watch(pathname + search)?.().version;
    const deploy = deployStatus();
    const grading = gradingAttention();
    const pause = autoMergePause();
    const repositories = store.frontier.listRepositoryProblems();
    return version === undefined ? { ...display, deploy, grading, autoMergePause: pause, repositories } : { ...display, version, deploy, grading, autoMergePause: pause, repositories };
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

  const boardSettings: BoardSettings = { maxConcurrent, maxOpenPullRequests, gradingRepositories, autoMergeRepositories, dispatchOrder, repositoryPriorities };

  app.get('/', (c) => c.html(boardPage({ store, settings: boardSettings, now: clock(), group: c.req.query('group'), display: displayOf(c) })));

  mountApi(app, store, clock, repositories);

  app.get('/work', (c) => c.redirect('/'));

  app.get('/runs', (c) => c.redirect(`/workloads${new URL(c.req.url).search}`));

  app.get('/workloads', (c) => {
    const shown = displayOf(c);
    const at = clock();
    const now = at.toISOString();
    const pullRequestWorkloads = new Map<string, RunPullRequestWorkload>([
      ...store.workloads.listRevisions(now).flatMap((workload): [string, RunPullRequestWorkload][] =>
        workload.runId === null ? [] : [[workload.runId, { kind: 'revision', workload }]],
      ),
      ...store.workloads.listConflictResolutions(now).flatMap((workload): [string, RunPullRequestWorkload][] =>
        workload.runId === null ? [] : [[workload.runId, { kind: 'conflict-resolution', workload }]],
      ),
    ]);
    const diagnoses = store.diagnoses.listDiagnoses(now);
    const categories = store.diagnoses.latestDiagnosisCategories(now);
    return c.html(renderList(store.runs.listRuns(), parseWorkloadFilter(c.req.query()), parsePage(c.req.query()), store.runs.listPriceEquivalents(), pullRequestWorkloads, store.workloads.mapRunDispatches(now), new Set(diagnoses.map(({ runId }) => runId)), categories, store.runs.runCohorts(), shown, at.getTime()));
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
      const options = store.grades.riskOptions();
      const fingerprint = query.cohort ?? options.cohorts[0];
      const { startedFrom, startedBefore } = dayRange(query.from, query.to, timeZone);
      const range = {
        ...(query.repository === undefined ? {} : { repository: query.repository }),
        ...(startedFrom === undefined ? {} : { gradedFrom: new Date(startedFrom).toISOString() }),
        ...(startedBefore === undefined ? {} : { gradedBefore: new Date(startedBefore).toISOString() }),
      };
      const grades = fingerprint === undefined ? [] : store.grades.listRiskGrades({ fingerprint, ...range });
      return c.html(renderRisk(aggregateRisk(grades), summarizeRisk(grades, store.grades.listFailedGradingHeads(range)), { ...query, ...(fingerprint === undefined ? {} : { cohort: fingerprint }) }, options, shown, autoMergeStatus(store), store.autoMerge.autoMergeCounts(range), autoMergeRepositories));
    }
    const filter = filterOf(query);
    return c.html(renderInsights(store.insights.listCohorts(filter), store.insights.listPoints(filter), store.insights.listProviderShares(filter), query, store.insights.options(), shown));
  });

  app.get(`/cohorts/${UNKNOWN_COHORT}`, (c) => {
    const shown = displayOf(c);
    return store.runs.hasUnknownConfigRuns() ? c.html(renderUnknownCohortPage(shown)) : c.notFound();
  });

  app.get('/cohorts/:hash', (c) => {
    const shown = displayOf(c);
    const hash = c.req.param('hash');
    const fingerprint = store.runs.getCohortFingerprint(hash);
    if (fingerprint === null) return c.notFound();
    const againstHash = c.req.query('against') ?? '';
    const against = againstHash === hash ? null : store.runs.getCohortFingerprint(againstHash);
    return c.html(renderCohortPage({ hash, fingerprint }, against === null ? null : { hash: againstHash, fingerprint: against }, store.runs.listCohortFingerprints(), store.insights.listCohorts({ kind: 'all', includeManual: false }).find((cohort) => cohort.hash === hash)?.failures ?? noFailures(), shown));
  });

  app.get('/tickets/:repository/:number', (c) => {
    const shown = displayOf(c);
    const number = Number(c.req.param('number'));
    if (!TICKET_NUMBER.test(c.req.param('number')) || !Number.isSafeInteger(number)) return c.notFound();
    const ticket = { repository: c.req.param('repository'), number };
    return c.html(renderTicketAttempts(ticket, store.workloads.listAttempts(ticket, clock().toISOString()), shown));
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
    const run = store.runs.getRun(c.req.param('id'));
    if (run === undefined) return c.notFound();
    const events =
      run.transcriptRef === null ? [] : transcripts.read(run.transcriptRef);
    const record = readRequestRecord((visit) => transcripts.scanRecords(requestRecordRef(run.id), visit));
    const at = clock();
    const now = at.toISOString();
    return c.html(renderDetail(run, events, record, store.runs.listGenerations(run.id), store.workloads.pullRequestOfRun(run.id), store.workloads.pullRequestWorkloadOfRun(run.id, now), store.workloads.dispatchOfRun(run.id, now), store.runs.listSkillLoads(run.id), downloadsOf(run), store.runs.getFingerprint(run.id), store.diagnoses.diagnosesOf(run.id, now), store.diagnoses.diagnosisOfRun(run.id, now), shown, at.getTime()));
  });

  app.get('/runs/:id/transcript', (c) => {
    const shown = displayOf(c);
    const run = store.runs.getRun(c.req.param('id'));
    if (run === undefined) return c.notFound();
    const events = run.transcriptRef === null ? [] : transcripts.read(run.transcriptRef);
    return c.html(renderFullTranscript(run, events, store.runs.listGenerations(run.id), store.runs.listSkillLoads(run.id), parseTranscriptShow(c.req.query('show')), shown));
  });

  const serveDownload = (path: `/runs/:id/${string}`, refOf: (run: RunRecord) => string | null): void => {
    app.get(path, (c) => {
      const run = store.runs.getRun(c.req.param('id'));
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
