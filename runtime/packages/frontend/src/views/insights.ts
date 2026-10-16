import { html } from 'hono/html';
import { renderChartLegend, renderCostChart, renderProviderShares, seriesOf } from '../chart.ts';
import { cohortHref, cohortLabel, DEFAULT_HARNESS, type CohortInsight, type InsightPoint, type InsightsFilter, type InsightsOptions, type ProviderShare, type ConfigFingerprint } from '@forge/shared';
import type { HtmlEscapedString } from 'hono/utils/html';
import { cacheHitRate, formatCost, formatMeasure, formatElapsed, formatRate } from '../format.ts';
import { type Rendered, ROW, renderCohortLink, SUBSCRIPTION_BADGE, CARD, type Cost, type Display, PAGE_TITLE, EMPTY, TABLE, layout, TD, PILL, LINK, TH } from './shared.ts';

const FIELD = 'flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.05em] text-muted';

const COHORT_TH = 'border-b border-line bg-raised px-2.5 py-2.5 text-[0.65rem] font-semibold uppercase leading-tight tracking-[0.04em] text-fg';

const COHORT_TD = 'border-t border-line px-2.5 py-2.5 align-baseline whitespace-nowrap text-right tabular-nums';

const INPUT = 'rounded-md border border-line bg-surface px-2 py-1.5 text-[0.9rem] font-normal normal-case tracking-normal text-fg';

const renderOptions = (values: string[], selected: string | undefined): Rendered =>
  html`${values.map((value) => html`<option value="${value}"${value === selected ? html` selected` : ''}>${value}</option>`)}`;

const LIST_PRICE_NOTE = html`<p class="m-0 mt-2 text-[0.8rem] text-muted" data-cost-note>Cohorts marked subscription show their list-price equivalent, what they would have cost at list price, not billed spend.</p>`;

const renderInsightsFilters = (
  filter: InsightsFilter,
  options: InsightsOptions,
): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<form method="get" action="/insights" class="mb-4 flex flex-wrap items-end gap-3" data-filters>
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
    <label class="${FIELD}">From
      <input type="date" name="from" value="${filter.from ?? ''}" class="${INPUT}" />
    </label>
    <label class="${FIELD}">To
      <input type="date" name="to" value="${filter.to ?? ''}" class="${INPUT}" />
    </label>
    <label class="flex items-center gap-2 py-2 text-[0.9rem] text-fg">
      <input type="checkbox" name="manual" value="1"${filter.includeManual ? html` checked` : ''} />Include manual workloads
    </label>
    <button type="submit" class="rounded-md border border-line bg-raised px-3 py-1.5 text-[0.9rem] font-semibold text-fg hover:bg-line">Apply</button>
  </form>`;

const COST_TITLE = html` title="List-price equivalent, not billed"`;

const renderCohort = (cohort: CohortInsight): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<tr class="${ROW}" data-cohort="${cohort.hash ?? ''}" data-cost-basis="${cohort.listPrice ? 'list-price' : 'billed'}">
    <td class="border-t border-line px-2.5 py-2.5 align-baseline whitespace-nowrap font-medium" data-metric="label"${cohort.hash === null ? '' : html` title="${cohort.hash}"`}>${renderCohortLink(cohort.hash, cohort.fingerprint)}${cohort.listPrice ? html` ${SUBSCRIPTION_BADGE}` : ''}</td>
    <td class="${COHORT_TD}" data-metric="workloads">${cohort.workloads}</td>
    <td class="${COHORT_TD}" data-metric="opened">${formatRate(cohort.openedRate)}</td>
    <td class="${COHORT_TD}" data-metric="merged">${formatRate(cohort.mergedRate)}</td>
    <td class="${COHORT_TD}" data-metric="cost-median"${cohort.listPrice ? COST_TITLE : ''}>${cohort.costMedian === null ? 'n/a' : formatCost(cohort.costMedian)}</td>
    <td class="${COHORT_TD}" data-metric="cost-p90"${cohort.listPrice ? COST_TITLE : ''}>${cohort.costP90 === null ? 'n/a' : formatCost(cohort.costP90)}</td>
    <td class="${COHORT_TD} font-semibold" data-metric="cost-per-merged"${cohort.listPrice ? COST_TITLE : ''}>${cohort.costPerMerged === null ? 'n/a' : formatCost(cohort.costPerMerged)}</td>
    <td class="${COHORT_TD}" data-metric="duration">${formatElapsed(cohort.durationMedianMs)}</td>
    <td class="${COHORT_TD}" data-metric="cache-hit">${formatRate(cohort.cacheHitRate)}</td>
    <td class="${COHORT_TD}" data-metric="tool-calls">${formatMeasure(cohort.toolCallsMedian)}</td>
    <td class="${COHORT_TD}" data-metric="retries">${formatMeasure(cohort.retriesPerWorkload)}</td>
    <td class="${COHORT_TD}" data-metric="rework">${formatMeasure(cohort.reworkPerMerged)}</td>
  </tr>`;

const renderCostOverTime = (
  cohorts: CohortInsight[],
  points: InsightPoint[],
  shares: ProviderShare[],
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const series = seriesOf(cohorts.map(({ hash }) => hash));
  return html`<section class="${CARD} mt-4 p-4" data-cost-chart aria-label="Cost over time">
    <h2 class="mb-2 text-sm font-semibold text-fg">Cost over time</h2>
    <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-8">
      <div class="w-full max-w-[30rem] shrink-0">${points.length === 0 ? html`<p class="m-0 text-[0.8rem] text-muted" data-chart-empty>No workload has a cost to plot.</p>` : renderCostChart(points, series)}</div>
      ${renderChartLegend(cohorts, points, series)}
    </div>
  </section>
  ${renderProviderShares(cohorts, shares)}`;
};

export const renderInsights = (
  cohorts: CohortInsight[],
  points: InsightPoint[],
  shares: ProviderShare[],
  filter: InsightsFilter,
  options: InsightsOptions,
  display: Display,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const body = html`<h1 class="${PAGE_TITLE}">Insights</h1>
    ${renderInsightsFilters(filter, options)}
    ${cohorts.length === 0
      ? html`<p class="${EMPTY}" data-empty>No workloads match.</p>`
      : html`<div class="${CARD}" data-cohorts role="region" aria-label="Cohort comparison" tabindex="0">
          <table class="${TABLE}">
            <thead>
              <tr>
                <th class="${COHORT_TH} text-left">Cohort</th>
                <th class="${COHORT_TH} text-right">Workloads</th>
                <th class="${COHORT_TH} text-right">Opened</th>
                <th class="${COHORT_TH} text-right">Merged</th>
                <th class="${COHORT_TH} text-right">Median cost</th>
                <th class="${COHORT_TH} text-right">p90 cost</th>
                <th class="${COHORT_TH} text-right">Cost per merged PR</th>
                <th class="${COHORT_TH} text-right">Median duration</th>
                <th class="${COHORT_TH} text-right">Cache hit</th>
                <th class="${COHORT_TH} text-right">Median tool calls</th>
                <th class="${COHORT_TH} text-right">Retries per workload</th>
                <th class="${COHORT_TH} text-right">Rework per merged PR</th>
              </tr>
            </thead>
            <tbody>${cohorts.map(renderCohort)}</tbody>
          </table>
        </div>
        ${cohorts.some(({ listPrice }) => listPrice) ? LIST_PRICE_NOTE : ''}
        ${renderCostOverTime(cohorts, points, shares)}`}`;
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
  { key: 'settings', label: 'Settings and hooks', valueOf: ({ settings }) => settings ?? 'none' },
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

const SHORT_COHORT_HASH_LENGTH = 8;

interface CohortConfig {
  hash: string;
  fingerprint: ConfigFingerprint;
}

const renderCompareForm = (current: CohortConfig, against: CohortConfig | null, cohorts: CohortConfig[]): Rendered =>
  html`<form method="get" action="/cohorts/${current.hash}" class="mb-4 flex flex-wrap items-end gap-3" data-compare>
    <label class="${FIELD}">Compare against
      <select name="against" class="${INPUT}">
        <option value="">No comparison</option>
        ${cohorts
          .filter(({ hash }) => hash !== current.hash)
          .map(({ hash, fingerprint }) => html`<option value="${hash}"${hash === against?.hash ? html` selected` : ''}>${cohortLabel(fingerprint)} (${hash.slice(0, SHORT_COHORT_HASH_LENGTH)})</option>`)}
      </select>
    </label>
    <button type="submit" class="rounded-md border border-line bg-raised px-3 py-1.5 text-[0.9rem] font-semibold text-fg hover:bg-line">Compare</button>
  </form>`;

export const renderCohortPage = (
  { hash, fingerprint }: CohortConfig,
  against: CohortConfig | null,
  cohorts: CohortConfig[],
  display: Display,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const body = html`<p class="m-0 mb-4 text-[0.9rem]"><a href="/insights" class="${LINK}">&larr; Insights</a></p>
    <h1 class="${PAGE_TITLE} break-words" data-cohort-label>${cohortLabel(fingerprint)}</h1>
    <p class="m-0 mb-4 break-all text-[0.9rem] text-muted tabular-nums" data-cohort-hash>${hash}</p>
    ${renderCompareForm({ hash, fingerprint }, against, cohorts)}
    <div class="${CARD}" data-fingerprint role="region" aria-label="Config fingerprint" tabindex="0">
      <table class="${TABLE}">
        ${against === null
          ? ''
          : html`<thead>
              <tr>
                <th class="${TH}">Field</th>
                <th class="${TH}">This cohort</th>
                <th class="${TH}">Compared with <a href="${cohortHref(against.hash)}" class="${LINK} normal-case tracking-normal">${cohortLabel(against.fingerprint)}</a></th>
              </tr>
            </thead>`}
        <tbody>${FINGERPRINT_FIELDS.map((field) => renderFingerprintRow(field, fingerprint, against?.fingerprint ?? null))}</tbody>
      </table>
    </div>`;
  return layout(cohortLabel(fingerprint), 'insights', true, display, body);
};

export const renderUnknownCohortPage = (display: Display): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const body = html`<p class="m-0 mb-4 text-[0.9rem]"><a href="/insights" class="${LINK}">&larr; Insights</a></p>
    <h1 class="${PAGE_TITLE} break-words" data-cohort-label>${cohortLabel(null)}</h1>
    <p class="${EMPTY}" data-unknown-cohort>These workloads were recorded before fingerprints existed, so their config is not known and there is nothing to compare.</p>`;
  return layout(cohortLabel(null), 'insights', true, display, body);
};
