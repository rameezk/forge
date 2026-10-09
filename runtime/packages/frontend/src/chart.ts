import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { extent, max } from 'd3-array';
import { scaleLinear, scaleUtc } from 'd3-scale';
import { cohortLabel } from '@forge/shared';
import type { CohortInsight, InsightPoint, ProviderShare, WorkloadOutcome } from '@forge/shared';
import { formatCost, formatRate } from './format.ts';

type Rendered = HtmlEscapedString | Promise<HtmlEscapedString>;

export interface Series {
  mark: string;
  swatch: string;
}

const SERIES: Series[] = [
  { mark: 'fill-series-1 stroke-series-1', swatch: 'bg-series-1' },
  { mark: 'fill-series-2 stroke-series-2', swatch: 'bg-series-2' },
  { mark: 'fill-series-3 stroke-series-3', swatch: 'bg-series-3' },
  { mark: 'fill-series-4 stroke-series-4', swatch: 'bg-series-4' },
  { mark: 'fill-series-5 stroke-series-5', swatch: 'bg-series-5' },
  { mark: 'fill-series-6 stroke-series-6', swatch: 'bg-series-6' },
];

const UNKNOWN_SERIES: Series = { mark: 'fill-muted stroke-muted', swatch: 'bg-muted' };

export const seriesOf = (hashes: (string | null)[]): Map<string | null, Series> => {
  const known = hashes.filter((hash): hash is string => hash !== null);
  const series = new Map<string | null, Series>(known.map((hash, index) => [hash, SERIES[index % SERIES.length]!]));
  if (hashes.includes(null)) series.set(null, UNKNOWN_SERIES);
  return series;
};

const SUBSCRIPTION_LABEL = 'subscription';

const seriesFor = (series: Map<string | null, Series>, key: string | null): Series => series.get(key) ?? UNKNOWN_SERIES;

const WIDTH = 420;
const HEIGHT = 250;
const MARGIN = { top: 12, right: 14, bottom: 30, left: 50 };
const DAY_MS = 24 * 60 * 60 * 1000;
const INSET = 8;
const DAY_LABEL = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

type Shape = 'circle' | 'diamond' | 'cross' | 'square';

const MANUAL = 'manual';

type Mark = WorkloadOutcome | typeof MANUAL;

const SHAPE_OF: Record<Mark, Shape> = { merged: 'circle', opened: 'diamond', failed: 'cross', [MANUAL]: 'square' };

const markOf = (outcome: WorkloadOutcome | null): Mark => outcome ?? MANUAL;

const renderShape = (shape: Shape): Rendered => {
  switch (shape) {
    case 'circle':
      return html`<circle data-shape="circle" r="5" stroke-width="0"></circle>`;
    case 'diamond':
      return html`<rect data-shape="diamond" x="-4" y="-4" width="8" height="8" transform="rotate(45)" stroke-width="0"></rect>`;
    case 'cross':
      return html`<path data-shape="cross" d="M-4 -4L4 4M-4 4L4 -4" fill="none" stroke-width="2" stroke-linecap="round"></path>`;
    case 'square':
      return html`<rect data-shape="square" x="-4" y="-4" width="8" height="8" fill="none" stroke-width="1.5"></rect>`;
  }
};

export const renderCostChart = (
  points: InsightPoint[],
  series: Map<string | null, Series>,
): Rendered => {
  const [first, last] = extent(points, ({ startTime }) => Date.parse(startTime)) as [number, number];
  const x = scaleUtc()
    .domain([new Date(Math.floor(first / DAY_MS) * DAY_MS), new Date((Math.floor(last / DAY_MS) + 1) * DAY_MS)])
    .range([MARGIN.left + INSET, WIDTH - MARGIN.right - INSET]);
  const y = scaleLinear()
    .domain([0, max(points, ({ costUsd }) => costUsd) || 1])
    .nice(5)
    .range([HEIGHT - MARGIN.bottom, MARGIN.top]);
  const costTicks = y.ticks(5);
  const costFormat = y.tickFormat(5);
  const timeTicks = x.ticks(6).filter((tick) => tick.getTime() % DAY_MS === 0);
  const left = MARGIN.left;
  const right = WIDTH - MARGIN.right;
  const bottom = HEIGHT - MARGIN.bottom;
  return html`<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" role="group" aria-label="Cost over time, one point per workload" class="block h-auto w-full" data-chart="cost">
    ${costTicks.map(
      (tick) => html`<g data-tick="cost" data-value="${tick}">
        <line x1="${left}" x2="${right}" y1="${y(tick)}" y2="${y(tick)}" class="stroke-line" stroke-width="1"></line>
        <text x="${left - 6}" y="${y(tick)}" text-anchor="end" dominant-baseline="middle" font-size="11" class="fill-muted">$${costFormat(tick)}</text>
      </g>`,
    )}
    ${timeTicks.map(
      (tick) => html`<g data-tick="time" data-value="${tick.toISOString()}">
        <line x1="${x(tick)}" x2="${x(tick)}" y1="${bottom}" y2="${bottom + 4}" class="stroke-muted" stroke-width="1"></line>
        <text x="${x(tick)}" y="${bottom + 16}" text-anchor="middle" font-size="11" class="fill-muted">${DAY_LABEL.format(tick)}</text>
      </g>`,
    )}
    <line x1="${left}" x2="${right}" y1="${bottom}" y2="${bottom}" class="stroke-muted" stroke-width="1"></line>
    ${points.map(
      ({ runId, fingerprintHash, startTime, costUsd, listPrice, outcome }) => html`<g data-point data-run="${runId}" data-cohort="${fingerprintHash ?? ''}" data-cost-basis="${listPrice ? 'list-price' : 'billed'}" data-outcome="${markOf(outcome)}" class="${seriesFor(series, fingerprintHash).mark}" transform="translate(${x(new Date(startTime))} ${y(costUsd)})">
        <title>${runId} - ${formatCost(costUsd)}${listPrice ? ' list-price equivalent' : ''} - ${markOf(outcome)}</title>
        <circle r="10" fill="transparent" stroke-width="0"></circle>
        ${renderShape(SHAPE_OF[markOf(outcome)])}
      </g>`,
    )}
  </svg>`;
};

export const renderChartLegend = (
  cohorts: CohortInsight[],
  points: InsightPoint[],
  series: Map<string | null, Series>,
): Rendered => {
  const marks = (['merged', 'opened', 'failed', MANUAL] as const).filter(
    (mark) => mark !== MANUAL || points.some((point) => point.outcome === null),
  );
  return html`<div class="flex flex-col gap-3 text-[0.8rem] text-muted">
    <ul class="flex flex-col gap-1" data-legend="cohorts">
      ${cohorts.map(
        ({ hash, fingerprint, listPrice }) => html`<li class="flex items-center gap-1.5" data-legend-cohort="${hash ?? ''}"><span class="inline-block h-2.5 w-2.5 shrink-0 rounded-full ${seriesFor(series, hash).swatch}"></span><span>${cohortLabel(fingerprint)}${listPrice ? html` <span class="text-muted">${SUBSCRIPTION_LABEL}, list-price equivalent</span>` : ''}</span></li>`,
      )}
    </ul>
    <ul class="flex flex-wrap gap-x-4 gap-y-1 lg:flex-col lg:gap-y-1" data-legend="outcomes">
      ${marks.map(
        (mark) => html`<li class="flex items-center gap-1.5"><svg viewBox="-7 -7 14 14" class="h-3.5 w-3.5 fill-muted stroke-muted" aria-hidden="true">${renderShape(SHAPE_OF[mark])}</svg>${mark}</li>`,
      )}
    </ul>
  </div>`;
};

export const renderProviderShares = (cohorts: CohortInsight[], shares: ProviderShare[]): Rendered => {
  const byCohort = new Map(shares.map((share) => [share.hash, share]));
  const swatches = seriesOf([...new Set(shares.flatMap(({ providers }) => providers.map(({ provider }) => provider)))].sort());
  return html`<section class="overflow-x-auto rounded-lg border border-line bg-surface mt-4 p-4" data-provider-shares aria-label="Provider share">
    <h2 class="mb-2 text-sm font-semibold text-fg">Provider share</h2>
    ${cohorts.map(({ hash, fingerprint }) => {
      const served = byCohort.get(hash)?.providers ?? [];
      const total = served.reduce((sum, { tokens }) => sum + tokens, 0);
      return html`<div class="mt-4 first:mt-0">
        <div class="mb-1.5 text-[0.8rem] font-medium text-fg">${cohortLabel(fingerprint)}</div>
        ${total === 0
          ? html`<div class="text-[0.8rem] text-muted">No provider data</div>`
          : html`<div class="flex h-3 w-full overflow-hidden rounded-full" aria-hidden="true">
                ${served.map(({ provider, tokens }) => html`<div class="${swatches.get(provider)?.swatch}" style="width: ${(tokens / total) * 100}%" title="${provider}"></div>`)}
              </div>
              <ul class="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[0.8rem] text-muted" data-provider-share="${hash ?? ''}">
                ${served.map(({ provider, tokens }) => html`<li class="flex items-center gap-1.5" data-provider="${provider}" data-share="${(tokens / total) * 100}"><span class="inline-block h-2.5 w-2.5 rounded-full ${swatches.get(provider)?.swatch}"></span>${provider} ${formatRate(tokens / total)}</li>`)}
              </ul>`}
      </div>`;
    })}
  </section>`;
};
