import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { extent, max } from 'd3-array';
import { scaleLinear, scaleUtc } from 'd3-scale';
import { cohortLabel } from '@forge/shared';
import type { CohortInsight, InsightPoint, ProviderShare, WorkloadOutcome } from '@forge/shared';
import { dayOf, nextDay, startOfDay } from './days.ts';
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

const PREVIOUS_SERIES: Series = { mark: 'fill-muted stroke-muted opacity-60', swatch: 'bg-muted opacity-60' };

const PREVIOUS_SHADES = ['opacity-80', 'opacity-55', 'opacity-35', 'opacity-20'];

export const seriesOf = (keys: string[]): Map<string, Series> =>
  new Map(keys.map((key, index) => [key, SERIES[index % SERIES.length]!]));

export const cohortSeriesOf = (cohorts: CohortInsight[]): Map<string | null, Series> => {
  const active = cohorts.filter(({ hash, activeFor }) => hash !== null && activeFor.length > 0);
  return new Map<string | null, Series>([
    ...cohorts.map(({ hash }): [string | null, Series] => [hash, PREVIOUS_SERIES]),
    ...active.map(({ hash }, index): [string | null, Series] => [hash, SERIES[index % SERIES.length]!]),
  ]);
};

const isPrevious = (series: Series): boolean => series === PREVIOUS_SERIES;

const SUBSCRIPTION_LABEL = 'subscription';

const seriesFor = (series: Map<string | null, Series>, key: string | null): Series => series.get(key) ?? PREVIOUS_SERIES;

const WIDTH = 420;
const HEIGHT = 250;
const MARGIN = { top: 12, right: 14, bottom: 30, left: 50 };
const TARGET_TICKS = 7;
const INSET = 8;

const dayLabel = (timeZone: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone });

const daysBetween = (first: string, last: string): string[] => {
  const days = [first];
  while (days[days.length - 1]! < last) days.push(nextDay(days[days.length - 1]!));
  return days;
};

const tickDays = (days: string[]): string[] => {
  const stride = Math.ceil(days.length / TARGET_TICKS);
  const ticks = [days[0]!];
  for (let covered = 0; covered < days.length; covered += stride) {
    let next = ticks[ticks.length - 1]!;
    for (let step = 0; step < stride; step++) next = nextDay(next);
    ticks.push(next);
  }
  return ticks;
};

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
  timeZone: string,
): Rendered => {
  const [first, last] = extent(points, ({ startTime }) => Date.parse(startTime)) as [number, number];
  const days = daysBetween(dayOf(first, timeZone), dayOf(last, timeZone));
  const ticks = tickDays(days);
  const x = scaleUtc()
    .domain([new Date(startOfDay(ticks[0]!, timeZone)), new Date(startOfDay(ticks[ticks.length - 1]!, timeZone))])
    .range([MARGIN.left + INSET, WIDTH - MARGIN.right - INSET]);
  const y = scaleLinear()
    .domain([0, max(points, ({ costUsd }) => costUsd) || 1])
    .nice(5)
    .range([HEIGHT - MARGIN.bottom, MARGIN.top]);
  const costTicks = y.ticks(5);
  const costFormat = y.tickFormat(5);
  const label = dayLabel(timeZone);
  const timeTicks = ticks.map((day) => new Date(startOfDay(day, timeZone)));
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
        <text x="${x(tick)}" y="${bottom + 16}" text-anchor="middle" font-size="11" class="fill-muted">${label.format(tick)}</text>
      </g>`,
    )}
    <line x1="${left}" x2="${right}" y1="${bottom}" y2="${bottom}" class="stroke-muted" stroke-width="1"></line>
    ${[...points].sort((a, b) => Number(isPrevious(seriesFor(series, b.fingerprintHash))) - Number(isPrevious(seriesFor(series, a.fingerprintHash)))).map(
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
        ({ hash, fingerprint, listPrice }) => html`<li class="flex items-center gap-1.5" data-legend-cohort="${hash ?? ''}"><span class="inline-block h-2.5 w-2.5 shrink-0 rounded-full ${seriesFor(series, hash).swatch}"></span><span>${cohortLabel(fingerprint, hash)}${listPrice ? html` <span class="text-muted">${SUBSCRIPTION_LABEL}, list-price equivalent</span>` : ''}</span></li>`,
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
  const previous = new Set(cohorts.filter(({ activeFor }) => activeFor.length === 0).map(({ hash }) => hash));
  const swatchOf = (hash: string | null, provider: string, index: number): string =>
    previous.has(hash) ? `bg-muted ${PREVIOUS_SHADES[index % PREVIOUS_SHADES.length]}` : (swatches.get(provider)?.swatch ?? '');
  return html`<section class="overflow-x-auto rounded-lg border border-line bg-surface mt-4 p-4" data-provider-shares aria-label="Provider share">
    <h2 class="mb-2 text-sm font-semibold text-fg">Provider share</h2>
    ${cohorts.map(({ hash, fingerprint }) => {
      const served = byCohort.get(hash)?.providers ?? [];
      const total = served.reduce((sum, { tokens }) => sum + tokens, 0);
      return html`<div class="mt-4 first:mt-0">
        <div class="mb-1.5 text-[0.8rem] font-medium text-fg">${cohortLabel(fingerprint, hash)}</div>
        ${total === 0
          ? html`<div class="text-[0.8rem] text-muted">No provider data</div>`
          : html`<div class="flex h-3 w-full overflow-hidden rounded-full" aria-hidden="true" data-provider-bar="${hash ?? ''}">
                ${served.map(({ provider, tokens }, index) => html`<div class="${swatchOf(hash, provider, index)}" style="width: ${(tokens / total) * 100}%" title="${provider}"></div>`)}
              </div>
              <ul class="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[0.8rem] text-muted" data-provider-share="${hash ?? ''}">
                ${served.map(({ provider, tokens }, index) => html`<li class="flex items-center gap-1.5" data-provider="${provider}" data-share="${(tokens / total) * 100}"><span class="inline-block h-2.5 w-2.5 rounded-full ${swatchOf(hash, provider, index)}"></span>${provider} ${formatRate(tokens / total)}</li>`)}
              </ul>`}
      </div>`;
    })}
  </section>`;
};
