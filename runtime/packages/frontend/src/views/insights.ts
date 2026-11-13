import { html } from 'hono/html';
import { renderChartLegend, renderCostChart, renderProviderShares, cohortSeriesOf } from '../chart.ts';
import { cohortHref, DIAGNOSIS_CATEGORIES, DIAGNOSIS_CATEGORY_LABELS, INSIGHT_KIND_FILTERS, sumFailures, UNKNOWN_COHORT, type CohortFailures, type DiagnosisCategory, type InsightKindFilter, cohortLabel, DEFAULT_HARNESS, type CohortInsight, type RanPair, type InsightPoint, type InsightsFilter, type InsightsOptions, type ProviderShare, RISK_GROUPS, type RiskOptions, type RiskRow, type ConfigFingerprint } from '@forge/shared';
import type { HtmlEscapedString } from 'hono/utils/html';
import { workloadsHref } from '../workload-filter.ts';
import { cacheHitRate, formatCost, formatMinute, formatStarted, formatMeasure, formatElapsed, formatRate } from '../format.ts';
import { type Rendered, ROW, renderCohortLink, SUBSCRIPTION_BADGE, CARD, type Cost, type Display, PAGE_TITLE, EMPTY, TABLE, layout, TD, PILL, LINK, TH } from './shared.ts';

export const INSIGHTS_TABS = ['delivery', 'cost', 'failures', 'risk'] as const;

export type InsightsTab = (typeof INSIGHTS_TABS)[number];

export const DEFAULT_INSIGHTS_TAB: InsightsTab = 'delivery';

export const defaultKindOf = (tab: InsightsTab): InsightKindFilter => (tab === 'failures' ? 'all' : 'dispatch');

export interface InsightsQuery extends InsightsFilter {
  tab: InsightsTab;
  from?: string;
  to?: string;
  cohort?: string;
}

const TAB_LABELS: Record<InsightsTab, string> = {
  delivery: 'Delivery',
  cost: 'Cost',
  failures: 'Failures',
  risk: 'Risk',
};

const FIELD = 'flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.05em] text-muted';

const COHORT_TH = 'border-b border-line bg-raised px-2.5 py-2.5 text-[0.65rem] font-semibold uppercase leading-tight tracking-[0.04em] text-fg';

const COHORT_TD = 'border-t border-line px-2.5 py-2.5 align-baseline whitespace-nowrap text-right tabular-nums';

const RUN_TD = 'border-t border-line px-2.5 py-2.5 align-baseline text-right tabular-nums';

const INPUT = 'rounded-md border border-line bg-surface px-2 py-1.5 text-[0.9rem] font-normal normal-case tracking-normal text-fg';

const renderOptions = (values: string[], selected: string | undefined): Rendered =>
  html`${values.map((value) => html`<option value="${value}"${value === selected ? html` selected` : ''}>${value}</option>`)}`;

const LIST_PRICE_NOTE = html`<p class="m-0 mt-2 text-[0.8rem] text-muted" data-cost-note>Cohorts marked subscription show their list-price equivalent, what they would have cost at list price, not billed spend.</p>`;

const KIND_LABELS: Record<InsightKindFilter, string> = {
  dispatch: 'Dispatch',
  revision: 'Revision',
  'conflict-resolution': 'Conflict resolution',
  all: 'All',
};

const tabHref = (filter: InsightsQuery, tab: InsightsTab): string => {
  const params = new URLSearchParams();
  if (tab !== DEFAULT_INSIGHTS_TAB) params.set('tab', tab);
  if (filter.kind !== defaultKindOf(filter.tab)) params.set('kind', filter.kind);
  if (filter.worker) params.set('worker', filter.worker);
  if (filter.repository) params.set('repository', filter.repository);
  if (filter.from) params.set('from', filter.from);
  if (filter.to) params.set('to', filter.to);
  if (filter.includeManual) params.set('manual', '1');
  return `/insights?${params.toString()}`;
};

const renderTabs = (filter: InsightsQuery): Rendered =>
  html`<nav class="mb-4 flex gap-1 border-b border-line" aria-label="Insights views" data-tabs>
    ${INSIGHTS_TABS.map(
      (tab) =>
        html`<a href="${tabHref(filter, tab)}" data-tab="${tab}"${tab === filter.tab ? html` aria-current="page"` : ''} class="-mb-px border-b-2 px-3 py-2 text-[0.9rem] font-semibold no-underline ${tab === filter.tab ? 'border-fg text-fg' : 'border-transparent text-muted hover:text-fg'}">${TAB_LABELS[tab]}</a>`,
    )}
  </nav>`;

const renderInsightsFilters = (
  filter: InsightsQuery,
  options: InsightsOptions,
): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<form method="get" action="/insights" class="mb-4 flex flex-wrap items-end gap-3" data-filters>
    <input type="hidden" name="tab" value="${filter.tab}" />
    <label class="${FIELD}">Worker
      <select name="worker" class="${INPUT}">
        <option value="">All</option>
        ${renderOptions(options.workers, filter.worker)}
      </select>
    </label>
    <label class="${FIELD}">Repository
      <select name="repository" class="${INPUT}">
        <option value="">All</option>
        ${renderOptions(options.repositories, filter.repository)}
      </select>
    </label>
    <label class="${FIELD}">Kind
      <select name="kind" class="${INPUT}">
        ${INSIGHT_KIND_FILTERS.map((kind) => html`<option value="${kind}"${kind === filter.kind ? html` selected` : ''}>${KIND_LABELS[kind]}</option>`)}
      </select>
    </label>
    <label class="${FIELD}">From
      <input type="date" name="from" value="${filter.from ?? ''}" class="${INPUT}" />
    </label>
    <label class="${FIELD}">To
      <input type="date" name="to" value="${filter.to ?? ''}" class="${INPUT}" />
    </label>
    ${filter.tab === 'failures' ? '' : html`<label class="flex items-center gap-2 py-2 text-[0.9rem] text-fg">
      <input type="checkbox" name="manual" value="1"${filter.includeManual ? html` checked` : ''} />Include manual workloads
    </label>`}
    <button type="submit" class="rounded-md border border-line bg-raised px-3 py-1.5 text-[0.9rem] font-semibold text-fg hover:bg-line">Apply</button>
  </form>`;

const COST_TITLE = html` title="List-price equivalent, not billed"`;

const renderRunTime = (metric: string, iso: string | null, timeZone: string): HtmlEscapedString | Promise<HtmlEscapedString> =>
  iso === null
    ? html`<td class="${RUN_TD}" data-metric="${metric}">n/a</td>`
    : html`<td class="${RUN_TD}" data-metric="${metric}" title="${formatStarted(iso, timeZone)}">${formatMinute(iso, timeZone).split(' ').map((part) => html`<span class="whitespace-nowrap">${part}</span>`).reduce((joined, part) => html`${joined} ${part}`)}</td>`;

const joinNames = (names: string[]): string =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

const ownersOf = (pairs: RanPair[]): string => {
  const repositories = new Map<string, string[]>();
  for (const { worker, repository } of pairs) {
    repositories.set(worker, repository === null ? (repositories.get(worker) ?? []) : [...(repositories.get(worker) ?? []), repository]);
  }
  return [...repositories].map(([worker, names]) => (names.length === 0 ? worker : `${worker} on ${joinNames(names)}`)).join('; ');
};

const renderOwners = ({ activeFor, ranFor }: CohortInsight): Rendered =>
  html`<p class="m-0 mt-0.5 text-[0.8rem] font-normal text-muted" data-owner>${activeFor.length === 0 ? `Ran for ${ownersOf(ranFor)}` : `Active for ${ownersOf(activeFor)}`}</p>`;

interface Column {
  header: string;
  divider?: boolean;
  render: (cohort: CohortInsight, timeZone: string) => HtmlEscapedString | Promise<HtmlEscapedString>;
}

type FailureSubject = Pick<CohortInsight, 'hash' | 'failures'>;

interface FailureColumn extends Column {
  render: (subject: FailureSubject) => HtmlEscapedString | Promise<HtmlEscapedString>;
}

const DIVIDER = ' border-l border-l-line';

const renderHeaders = (columns: Column[]): Rendered =>
  html`${columns.map(({ header, divider }) => html`<th class="${COHORT_TH} text-right${divider === true ? DIVIDER : ''}">${header}</th>`)}`;

const metricCell = (metric: string, text: (cohort: CohortInsight) => string, extra = ''): Column['render'] => (cohort) =>
  html`<td class="${COHORT_TD}${extra}" data-metric="${metric}">${text(cohort)}</td>`;

const costCell = (metric: string, valueOf: (cohort: CohortInsight) => number | null, extra = ''): Column['render'] => (cohort) => {
  const value = valueOf(cohort);
  return html`<td class="${COHORT_TD}${extra}" data-metric="${metric}"${cohort.listPrice ? COST_TITLE : ''}>${value === null ? 'n/a' : formatCost(value)}</td>`;
};

const WORKLOADS: Column = { header: 'Workloads', render: metricCell('workloads', ({ workloads }) => String(workloads)) };

const DIM = ' text-muted opacity-60';

const cohortKey = (hash: string | null): string => hash ?? UNKNOWN_COHORT;

const countLink = (href: string, count: number): Rendered =>
  html`<a href="${href}" class="${LINK}${count === 0 ? DIM : ''}">${count}</a>`;

const failedCell: FailureColumn['render'] = ({ hash, failures }: FailureSubject) =>
  html`<td class="${COHORT_TD}" data-metric="failed">${countLink(workloadsHref({ cohort: cohortKey(hash), status: 'failed' }), failures.failed)}</td>`;

const diagnosedCell: FailureColumn['render'] = ({ failures: { diagnosed, failed } }: FailureSubject) =>
  html`<td class="${COHORT_TD}${failed === 0 ? DIM : ''}" data-metric="diagnosed">${diagnosed} of ${failed}</td>`;

const categoryColumn = (category: DiagnosisCategory, divider: boolean): FailureColumn => ({
  header: DIAGNOSIS_CATEGORY_LABELS[category],
  divider,
  render: ({ hash, failures }: FailureSubject) =>
    html`<td class="${COHORT_TD}${divider ? DIVIDER : ''}" data-metric="cause-${category}">${countLink(workloadsHref({ cohort: cohortKey(hash), category }), failures.categories[category])}</td>`,
});

const FAILURE_COLUMNS: FailureColumn[] = [
  { header: 'Failed', render: failedCell },
  { header: 'Diagnosed', render: diagnosedCell },
  ...DIAGNOSIS_CATEGORIES.map((category, index) => categoryColumn(category, index === 0)),
];

const TAB_COLUMNS: Record<InsightsTab, Column[]> = {
  delivery: [
    { header: 'First run', render: ({ firstRun }, timeZone) => renderRunTime('first-run', firstRun, timeZone) },
    { header: 'Last run', render: ({ lastRun }, timeZone) => renderRunTime('last-run', lastRun, timeZone) },
    WORKLOADS,
    { header: 'Done', render: metricCell('done', ({ doneRate }) => formatRate(doneRate)) },
    { header: 'Opened', render: metricCell('opened', ({ openedRate }) => formatRate(openedRate)) },
    { header: 'Merged', render: metricCell('merged', ({ mergedRate }) => formatRate(mergedRate)) },
    { header: 'Retries per workload', render: metricCell('retries', ({ retriesPerWorkload }) => formatMeasure(retriesPerWorkload)) },
    { header: 'Rework per merged PR', render: metricCell('rework', ({ reworkPerMerged }) => formatMeasure(reworkPerMerged)) },
    { header: 'Median duration', render: metricCell('duration', ({ durationMedianMs }) => formatElapsed(durationMedianMs)) },
    { header: 'Median tool calls', render: metricCell('tool-calls', ({ toolCallsMedian }) => formatMeasure(toolCallsMedian)) },
  ],
  cost: [
    WORKLOADS,
    { header: 'Median cost', render: costCell('cost-median', ({ costMedian }) => costMedian) },
    { header: 'p90 cost', render: costCell('cost-p90', ({ costP90 }) => costP90) },
    { header: 'Cost per merged PR', render: costCell('cost-per-merged', ({ costPerMerged }) => costPerMerged, ' font-semibold') },
    { header: 'Cache hit', render: metricCell('cache-hit', ({ cacheHitRate: rate }) => formatRate(rate)) },
  ],
  failures: FAILURE_COLUMNS,
  risk: [],
};

const PINNED = 'sticky left-0 z-10 shadow-[1px_0_0_var(--color-line)]';

const renderCohort = (cohort: CohortInsight, columns: Column[], timeZone: string): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<tr class="${ROW} group" data-cohort="${cohort.hash ?? ''}" data-cost-basis="${cohort.listPrice ? 'list-price' : 'billed'}">
    <td class="${PINNED} border-t border-line bg-surface group-hover:bg-bg px-2.5 py-2.5 align-baseline font-medium" data-metric="label"${cohort.hash === null ? '' : html` title="${cohort.hash}"`}>${renderCohortLink(cohort.hash, cohort.fingerprint)}${cohort.listPrice ? html` ${SUBSCRIPTION_BADGE}` : ''}${renderOwners(cohort)}</td>
    ${columns.map(({ render }) => render(cohort, timeZone))}
  </tr>`;

const GROUP_HEADER = 'border-t border-line bg-raised px-2.5 py-2 text-left text-xs font-semibold uppercase tracking-[0.05em] text-fg';

const renderGroup = (
  group: 'active' | 'previous',
  title: string,
  cohorts: CohortInsight[],
  columns: Column[],
  timeZone: string,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  if (cohorts.length === 0) return html``;
  const span = columns.length + 1;
  const lastRun = cohorts.map((cohort) => cohort.lastRun).filter((iso): iso is string => iso !== null).sort().at(-1) ?? null;
  const header =
    group === 'active'
      ? html`<th scope="colgroup" colspan="${span}" class="${GROUP_HEADER}"><span class="sticky left-2.5">${title}</span></th>`
      : html`<th scope="colgroup" colspan="${span}" class="${GROUP_HEADER}"><button type="button" data-group-toggle aria-expanded="false" class="group flex w-full cursor-pointer items-baseline gap-2 border-0 bg-transparent p-0 text-left font-[inherit] text-[inherit] uppercase tracking-[inherit] text-fg"><span class="sticky left-2.5 flex items-baseline gap-2"><span aria-hidden="true" class="inline-block w-3 text-center text-[0.65rem] text-muted transition-transform group-aria-expanded:rotate-90">▶</span>${title}<span class="tabular-nums" data-group-count>${cohorts.length}</span>${lastRun === null ? '' : html`<span class="font-normal normal-case tracking-normal text-muted" data-group-last-run>last run ${formatMinute(lastRun, timeZone)}</span>`}</span></button></th>`;
  return html`<tbody data-cohort-group="${group}"${group === 'active' ? '' : html` data-collapsed`} class="data-[collapsed]:[&>tr:not([data-group-header])]:hidden">
    <tr data-group-header>${header}</tr>
    ${cohorts.map((cohort) => renderCohort(cohort, columns, timeZone))}
  </tbody>`;
};

const renderCostSection = (
  cohorts: CohortInsight[],
  points: InsightPoint[],
  timeZone: string,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const series = cohortSeriesOf(cohorts);
  return html`<section class="${CARD} p-4" data-cost-chart aria-label="Cost over time">
    <h2 class="mb-2 text-sm font-semibold text-fg">Cost over time</h2>
    <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-8">
      <div class="w-full max-w-[30rem] shrink-0">${points.length === 0 ? html`<p class="m-0 text-[0.8rem] text-muted" data-chart-empty>No workload has a cost to plot.</p>` : renderCostChart(points, series, timeZone)}</div>
      ${renderChartLegend(cohorts, points, series)}
    </div>
  </section>`;
};

const renderCauses = (cohorts: CohortInsight[]): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const active = cohorts.filter(({ activeFor }) => activeFor.length > 0);
  const cohort = active.map(({ hash }) => cohortKey(hash)).join(',');
  const { failed, diagnosed, categories } = sumFailures(active.map(({ failures }) => failures));
  const tile = (key: string, label: string, count: number, href: string | null): Rendered =>
    html`<li data-cause="${key}" class="flex min-w-28 flex-col rounded-md border border-line bg-surface px-3 py-2"><span class="text-xs font-semibold uppercase tracking-[0.05em] text-muted">${label}</span>${href === null ? html`<span class="text-xl font-semibold tabular-nums${count === 0 ? DIM : ''}">${count}</span>` : html`<a href="${href}" class="text-xl font-semibold tabular-nums no-underline hover:underline${count === 0 ? DIM : ''}">${count}</a>`}</li>`;
  const widest = Math.max(1, ...DIAGNOSIS_CATEGORIES.map((category) => categories[category]));
  return html`<section class="${CARD} mb-4 p-4" data-causes aria-label="Causes">
    <h2 class="mb-2 text-sm font-semibold text-fg">Causes</h2>
    <ul class="m-0 mb-4 flex list-none flex-wrap gap-3 p-0">
      ${tile('failed', 'Failed', failed, active.length === 0 ? null : workloadsHref({ cohort, status: 'failed' }))}
      ${tile('diagnosed', 'Diagnosed', diagnosed, null)}
      ${tile('undiagnosed', 'Not diagnosed', failed - diagnosed, null)}
    </ul>
    <ul class="m-0 flex list-none flex-col gap-1.5 p-0">
      ${DIAGNOSIS_CATEGORIES.map((category) => html`<li data-cause="${category}" class="grid grid-cols-[11rem_1fr_3rem] items-center gap-3 text-[0.9rem]">
        <span class="text-fg">${DIAGNOSIS_CATEGORY_LABELS[category]}</span>
        <span aria-hidden="true" class="block h-2 rounded-sm bg-raised"><span class="block h-2 rounded-sm bg-fg" style="width: ${(categories[category] / widest) * 100}%"></span></span>
        ${active.length === 0 ? html`<span class="text-right tabular-nums${DIM}">${categories[category]}</span>` : html`<a href="${workloadsHref({ cohort, category })}" class="${LINK} text-right tabular-nums${categories[category] === 0 ? DIM : ''}">${categories[category]}</a>`}
      </li>`)}
    </ul>
  </section>`;
};

const renderCohortTable = (cohorts: CohortInsight[], tab: InsightsTab, timeZone: string): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const columns = TAB_COLUMNS[tab];
  return html`<div class="${CARD}" data-cohorts role="region" aria-label="Cohort comparison" tabindex="0">
    <table class="${TABLE}">
      <thead>
        <tr>
          <th class="${COHORT_TH} ${PINNED} text-left">Cohort</th>
          ${renderHeaders(columns)}
        </tr>
      </thead>
      ${renderGroup('active', 'Active cohorts', cohorts.filter(({ activeFor }) => activeFor.length > 0), columns, timeZone)}
      ${renderGroup('previous', 'Previous cohorts', cohorts.filter(({ activeFor }) => activeFor.length === 0), columns, timeZone)}
    </table>
  </div>`;
};

export const renderInsights = (
  cohorts: CohortInsight[],
  points: InsightPoint[],
  shares: ProviderShare[],
  filter: InsightsQuery,
  options: InsightsOptions,
  display: Display,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const table = (): HtmlEscapedString | Promise<HtmlEscapedString> => renderCohortTable(cohorts, filter.tab, display.timeZone);
  const content =
    cohorts.length === 0
      ? html`<p class="${EMPTY}" data-empty>No workloads match.</p>`
      : filter.tab === 'cost'
        ? html`${renderCostSection(cohorts, points, display.timeZone)}
          <div class="mt-4">${table()}</div>
          ${cohorts.some(({ listPrice }) => listPrice) ? LIST_PRICE_NOTE : ''}
          ${renderProviderShares(cohorts, shares)}`
        : filter.tab === 'failures'
          ? html`${renderCauses(cohorts)}${table()}`
          : table();
  const body = html`<h1 class="${PAGE_TITLE}">Insights</h1>
    ${renderTabs(filter)}
    ${renderInsightsFilters(filter, options)}
    ${content}`;
  return layout('Insights', 'insights', true, display, body);
};

const cohortOptionLabel = (fingerprint: string): string => {
  const split = fingerprint.lastIndexOf(':');
  return split < 0 ? fingerprint : `${fingerprint.slice(0, split)} ${fingerprint.slice(split + 1, split + 9)}`;
};

const renderRiskFilters = (filter: InsightsQuery, options: RiskOptions): Rendered =>
  html`<form method="get" action="/insights" class="mb-4 flex flex-wrap items-end gap-3" data-filters>
    <input type="hidden" name="tab" value="risk" />
    <label class="${FIELD}">Grading cohort
      <select name="cohort" class="${INPUT}">
        ${options.cohorts.map((cohort) => html`<option value="${cohort}"${cohort === filter.cohort ? html` selected` : ''}>${cohortOptionLabel(cohort)}</option>`)}
      </select>
    </label>
    <label class="${FIELD}">Repository
      <select name="repository" class="${INPUT}">
        <option value="">All</option>
        ${renderOptions(options.repositories, filter.repository)}
      </select>
    </label>
    <label class="${FIELD}">From
      <input type="date" name="from" value="${filter.from ?? ''}" class="${INPUT}" />
    </label>
    <label class="${FIELD}">To
      <input type="date" name="to" value="${filter.to ?? ''}" class="${INPUT}" />
    </label>
    <button type="submit" class="rounded-md border border-line bg-raised px-3 py-1.5 text-[0.9rem] font-semibold text-fg hover:bg-line">Apply</button>
  </form>`;

const UNKNOWN_SUPERSEDE_NOTE = 'Superseded before the cause was recorded. Counts against the grade.';

const RISK_GROUP_SPAN = 10;

const count = (metric: string, value: number, extra = ''): Rendered =>
  html`<td class="${COHORT_TD}${value === 0 ? DIM : ''}${extra}" data-metric="${metric}">${value}</td>`;

const renderRiskRow = (row: RiskRow): Rendered => {
  const empty = row.heads === 0;
  return html`<tr class="${ROW}${empty ? ' text-muted' : ''}" data-risk-row="${row.level}" data-unsettled="${String(row.unsettled)}">
    <th scope="row" class="${PINNED} whitespace-nowrap border-t border-line bg-surface py-2.5 pr-2.5 text-left align-baseline font-medium ${row.unsettled ? 'pl-7' : 'pl-2.5'}">${row.level}${row.unsettled ? html` <span class="${PILL} bg-warning-soft align-middle text-warning" data-unsettled-pill>unsettled</span>` : ''}</th>
    <td class="${COHORT_TD}" data-metric="held-up">${formatRate(row.heldUpRate)} <span class="text-muted">${row.merged} / ${row.settled}</span></td>
    ${count('heads', row.heads)}
    ${count('prs', row.pullRequests)}
    ${count('merged', row.merged)}
    ${count('superseded-unknown', row.superseded, ' border-l border-l-line')}
    ${count('closed', row.closed, ' border-l border-l-line')}
    ${count('open', row.open)}
    <td class="${COHORT_TD}" data-metric="confidence">${row.medianConfidence === null ? 'n/a' : row.medianConfidence.toFixed(2)}</td>
    <td class="${COHORT_TD}" data-metric="revisions">${row.meanRevisions === null ? 'n/a' : row.meanRevisions.toFixed(2)}</td>
  </tr>`;
};

const renderRiskTable = (rows: RiskRow[]): Rendered =>
  html`<div class="${CARD}" data-risk role="region" aria-label="Risk grades" tabindex="0">
    <table class="${TABLE}">
      <thead>
        <tr>
          <th rowspan="2" class="${COHORT_TH} ${PINNED} text-left">Level</th>
          <th rowspan="2" class="${COHORT_TH} text-right">Held up</th>
          <th rowspan="2" class="${COHORT_TH} text-right">Heads</th>
          <th rowspan="2" class="${COHORT_TH} text-right">PRs</th>
          <th rowspan="2" class="${COHORT_TH} text-right">Merged as graded</th>
          <th class="${COHORT_TH} text-right${DIVIDER}">Superseded by</th>
          <th rowspan="2" class="${COHORT_TH} text-right${DIVIDER}">Closed</th>
          <th rowspan="2" class="${COHORT_TH} text-right">Open</th>
          <th rowspan="2" class="${COHORT_TH} text-right">Median confidence</th>
          <th rowspan="2" class="${COHORT_TH} text-right">Revisions after grade</th>
        </tr>
        <tr>
          <th class="${COHORT_TH} text-right${DIVIDER}" title="${UNKNOWN_SUPERSEDE_NOTE}">Unknown</th>
        </tr>
      </thead>
      ${RISK_GROUPS.map(
        ({ key, title, levels }) => html`<tbody data-risk-group="${key}">
          <tr data-group-header><th scope="colgroup" colspan="${RISK_GROUP_SPAN}" class="${GROUP_HEADER}"><span class="sticky left-2.5">${title}</span></th></tr>
          ${rows.filter(({ level }) => levels.includes(level)).map(renderRiskRow)}
        </tbody>`,
      )}
    </table>
  </div>`;

export const renderRisk = (
  rows: RiskRow[],
  filter: InsightsQuery,
  options: RiskOptions,
  display: Display,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const content = rows.every(({ heads }) => heads === 0)
    ? html`<p class="${EMPTY}" data-empty>No risk grades in this range</p>`
    : html`${renderRiskTable(rows)}
      <p class="m-0 mt-2 text-[0.8rem] text-muted" data-risk-note>Held up is the share of settled grades merged at the graded head. Settled means merged, superseded or closed; open grades are counted only. No supersede cause is recorded yet, so every superseded grade is unknown and counts against the grade. Revisions after grade is the mean number of completed revisions that started after the grade and before its outcome, over settled grades.</p>`;
  const body = html`<h1 class="${PAGE_TITLE}">Insights</h1>
    ${renderTabs(filter)}
    ${renderRiskFilters(filter, options)}
    ${content}`;
  return layout('Insights', 'insights', true, display, body);
};

const FINGERPRINT_FIELDS: { key: string; label: string; valueOf: (fingerprint: ConfigFingerprint) => string }[] = [
  { key: 'harness', label: 'Harness', valueOf: ({ harness }) => harness ?? DEFAULT_HARNESS },
  { key: 'provider', label: 'Provider', valueOf: ({ provider }) => provider ?? 'openrouter' },
  { key: 'model', label: 'Model', valueOf: ({ model }) => model },
  { key: 'reasoning-effort', label: 'Reasoning effort', valueOf: ({ reasoningEffort }) => reasoningEffort ?? 'default' },
  { key: 'harness-args', label: 'Harness extra args', valueOf: ({ harnessArgs }) => (harnessArgs.length === 0 ? 'none' : harnessArgs.join(' ')) },
  { key: 'harness-version', label: 'Harness version', valueOf: ({ harnessVersion }) => harnessVersion ?? 'unknown' },
  { key: 'prompt-template', label: 'Prompt template', valueOf: ({ promptTemplate }) => promptTemplate },
  { key: 'system-prompt', label: 'System prompt', valueOf: ({ systemPrompt }) => systemPrompt ?? 'not recorded' },
  { key: 'tools', label: 'Tool definitions', valueOf: ({ tools }) => tools ?? 'not recorded' },
  { key: 'skills', label: 'Skill files', valueOf: ({ skills }) => skills ?? 'not recorded' },
  { key: 'settings', label: 'Forge settings', valueOf: ({ settings }) => settings ?? 'none' },
  { key: 'plugin', label: 'Plugin directory', valueOf: ({ plugin }) => plugin ?? 'none' },
  { key: 'instructions', label: 'Repository instructions', valueOf: ({ instructions }) => (instructions === undefined ? 'not recorded' : (instructions ?? 'no instructions file')) },
];

const renderFingerprintRow = (
  { key, label, valueOf }: (typeof FINGERPRINT_FIELDS)[number],
  fingerprint: ConfigFingerprint,
  against: ConfigFingerprint | null,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const value = valueOf(fingerprint);
  const labelCell = (changed: boolean): Rendered =>
    html`<th scope="row" class="${TD} whitespace-nowrap text-left font-semibold text-muted">${label}${changed ? html` <span class="${PILL} bg-warning-soft text-warning">changed</span>` : ''}</th>`;
  if (against === null) {
    return html`<tr class="${ROW}" data-field="${key}">${labelCell(false)}<td class="${TD} min-w-44 break-all tabular-nums">${value}</td></tr>`;
  }
  const other = valueOf(against);
  const changed = value !== other;
  return html`<tr class="${ROW}${changed ? ' bg-warning-soft' : ''}" data-field="${key}" data-changed="${String(changed)}">
    ${labelCell(changed)}
    <td class="${TD} min-w-44 break-all tabular-nums">${value}</td>
    <td class="${TD} min-w-44 break-all tabular-nums">${other}</td>
  </tr>`;
};

interface CohortConfig {
  hash: string;
  fingerprint: ConfigFingerprint;
}

const renderCompareForm = (current: CohortConfig, against: CohortConfig | null, cohorts: CohortConfig[]): Rendered =>
  html`<form method="get" action="/cohorts/${current.hash}" class="mb-4 flex flex-wrap items-end gap-3" data-compare>
    <label class="${FIELD} max-w-full">Compare against
      <select name="against" class="${INPUT} max-w-full">
        <option value="">No comparison</option>
        ${cohorts
          .filter(({ hash }) => hash !== current.hash)
          .map(({ hash, fingerprint }) => html`<option value="${hash}"${hash === against?.hash ? html` selected` : ''}>${cohortLabel(fingerprint, hash)}</option>`)}
      </select>
    </label>
    <button type="submit" class="rounded-md border border-line bg-raised px-3 py-1.5 text-[0.9rem] font-semibold text-fg hover:bg-line">Compare</button>
  </form>`;

const renderCohortFailures = (subject: FailureSubject): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<h2 class="mb-2 text-sm font-semibold text-fg">Failures</h2>
  <section class="${CARD} mb-4" data-failures role="region" aria-label="Failures" tabindex="0">
    <table class="${TABLE}">
      <thead><tr>${renderHeaders(FAILURE_COLUMNS)}</tr></thead>
      <tbody><tr class="${ROW}">${FAILURE_COLUMNS.map(({ render }) => render(subject))}</tr></tbody>
    </table>
  </section>`;

export const renderCohortPage = (
  { hash, fingerprint }: CohortConfig,
  against: CohortConfig | null,
  cohorts: CohortConfig[],
  failures: CohortFailures,
  display: Display,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const body = html`<p class="m-0 mb-4 text-[0.9rem]"><a href="/insights" class="${LINK}">&larr; Insights</a></p>
    <h1 class="${PAGE_TITLE} break-words" data-cohort-label>${cohortLabel(fingerprint, hash)}</h1>
    <p class="m-0 mb-4 break-all text-[0.9rem] text-muted tabular-nums" data-cohort-hash>${hash}</p>
    ${renderCohortFailures({ hash, failures })}
    ${renderCompareForm({ hash, fingerprint }, against, cohorts)}
    <div class="${CARD}" data-fingerprint role="region" aria-label="Config fingerprint" tabindex="0">
      <table class="${TABLE}">
        ${against === null
          ? ''
          : html`<thead>
              <tr>
                <th class="${TH}">Field</th>
                <th class="${TH}">This cohort</th>
                <th class="${TH}">Compared with <a href="${cohortHref(against.hash)}" class="${LINK} normal-case tracking-normal">${cohortLabel(against.fingerprint, against.hash)}</a></th>
              </tr>
            </thead>`}
        <tbody>${FINGERPRINT_FIELDS.map((field) => renderFingerprintRow(field, fingerprint, against?.fingerprint ?? null))}</tbody>
      </table>
    </div>`;
  return layout(cohortLabel(fingerprint, hash), 'insights', true, display, body);
};

export const renderUnknownCohortPage = (display: Display): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const body = html`<p class="m-0 mb-4 text-[0.9rem]"><a href="/insights" class="${LINK}">&larr; Insights</a></p>
    <h1 class="${PAGE_TITLE} break-words" data-cohort-label>${cohortLabel(null, null)}</h1>
    <p class="${EMPTY}" data-unknown-cohort>These workloads were recorded before fingerprints existed, so their config is not known and there is nothing to compare.</p>`;
  return layout(cohortLabel(null, null), 'insights', true, display, body);
};
