import { html } from 'hono/html';
import { cacheHitRate, formatCost, formatStepDuration } from '../format.ts';
import type { Step, StepKind, Trace } from '../trace.ts';
import { BADGE, BLOCK, CARD, DISCLOSURE, ESTIMATED_BADGE, INLINE_DISCLOSURE, PENDING, SECTION_TITLE, SUBSCRIPTION_BADGE, SUMMARY_FIGURE, type Rendered } from './shared.ts';

const BILLED_BADGE = html`<span class="${BADGE} ml-1.5 bg-line text-fg" data-badge="billed" title="The cost OpenRouter billed for this generation">billed</span>`;

const CACHE_MISS_BADGE = html`<span class="${BADGE} mr-1.5 bg-warning-soft text-warning" data-badge="cache-miss" title="This call's cache read fell well below the previous call's prompt size, so most of its prompt was not served from the cache">miss</span>`;

const KIND_LABELS: Record<StepKind, string> = {
  generation: 'generation',
  tool: 'tool',
  subagent: 'subagent',
  compaction: 'compaction',
  cache_warm: 'cache warm',
};

const KIND_TITLES: Record<StepKind, string> = {
  generation: 'A model call',
  tool: 'A tool run asked for by the generation above it',
  subagent: 'A subagent started by the generation above it',
  compaction: 'The summary model call behind a context compaction',
  cache_warm: 'A request that kept the prompt cache warm',
};

const kindBadge = (kind: StepKind): Rendered =>
  html`<span class="${BADGE} bg-line text-fg" data-badge="${kind === 'cache_warm' ? 'cache-warm' : kind}" title="${KIND_TITLES[kind]}">${KIND_LABELS[kind]}</span>`;

const retryBadge = (retries: number): Rendered =>
  retries === 0
    ? ''
    : html`<span class="${BADGE} bg-warning-soft text-warning" data-badge="retry" title="This generation was retried">${retries === 1 ? 'retried' : `retried ×${retries}`}</span>`;

const renderCost = ({ cost, usd, kind }: Step): Rendered => {
  if (cost === null) return kind === 'subagent' ? html`${formatCost(usd)}` : '';
  switch (cost.basis) {
    case 'billed':
      return html`${formatCost(cost.usd)}<wbr>${BILLED_BADGE}`;
    case 'estimated':
      return html`${formatCost(cost.usd)}<wbr>${ESTIMATED_BADGE}`;
    case 'list-price':
      return html`<span title="What this generation would have cost at the model's list price. Not billed.">${formatCost(cost.usd)}</span>`;
    case 'subscription':
      return SUBSCRIPTION_BADGE;
    case 'pending':
      return html`<span class="${PENDING}">pending</span>`;
  }
};

const TRACK = 'block h-2 min-w-8 flex-1 rounded-sm bg-raised sm:w-48 sm:flex-none';

const toneOf = (step: Step): string => (step.cacheMiss ? 'bg-warning' : step.kind === 'subagent' ? 'bg-fg' : 'bg-accent');

const OPEN_ENDED = '[mask-image:linear-gradient(to_right,black_50%,transparent)]';

const percent = (share: number): number => Number(share.toFixed(2));

const renderBar = (step: Step, maxUsd: number): Rendered => {
  const share = maxUsd === 0 ? 0 : (step.usd / maxUsd) * 100;
  return html`<span aria-hidden="true" class="${TRACK}" data-step-track><span class="block h-2 rounded-sm ${toneOf(step)}" data-step-bar style="width: ${share}%"></span></span>`;
};

const isOpen = (step: Step, { live }: Axis): boolean => live && step.start !== null && step.end === null;

const renderTimeBar = (step: Step, axis: Axis): Rendered => {
  if (step.start === null) return html`<span aria-hidden="true" class="${TRACK} relative" data-step-timeline></span>`;
  const end = Math.max(step.end ?? axis.end, step.start);
  const left = percent(((step.start - axis.start) / axis.span) * 100);
  const width = percent(((end - step.start) / axis.span) * 100);
  const open = isOpen(step, axis) ? ` ${OPEN_ENDED}` : '';
  return html`<span aria-hidden="true" class="${TRACK} relative" data-step-timeline><span class="absolute top-0 block h-2 min-w-0.5 rounded-sm ${toneOf(step)}${open}" data-step-time-bar style="left: ${left}%; width: ${width}%"></span></span>`;
};

const renderDuration = (step: Step, axis: Axis): Rendered => {
  if (step.start === null) return html`<span class="${DURATION}" data-step-duration></span>`;
  if (isOpen(step, axis)) return html`<span class="${DURATION}" data-step-duration>running</span>`;
  return html`<span class="${DURATION}" data-step-duration>${formatStepDuration(Math.max(step.end ?? axis.end, step.start) - step.start)}</span>`;
};

interface Axis {
  start: number;
  end: number;
  span: number;
  live: boolean;
}

const DURATION = 'shrink-0 text-right text-[0.85rem] tabular-nums text-muted sm:w-16';

const axisOf = (trace: Trace, live: boolean): Axis | null =>
  trace.start === null || trace.end === null
    ? null
    : { start: trace.start, end: trace.end, span: Math.max(trace.end - trace.start, 1), live };

const BAR_VIEWS = '[&[data-bars=time]_[data-step-track]]:hidden [&[data-bars=cost]_[data-step-timeline]]:hidden';

const UNNAMED = html`<span class="min-w-0 truncate text-[0.9rem] italic text-muted" data-step-name>model not recorded</span>`;

const renderRow = (step: Step, maxUsd: number, axis: Axis | null): Rendered =>
  html`<span class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 sm:gap-x-3"><span class="flex min-w-0 basis-full items-center gap-2 sm:basis-0 sm:flex-1">${step.cacheMiss ? CACHE_MISS_BADGE : ''}${kindBadge(step.kind)}${retryBadge(step.retries)}${step.name === '' ? UNNAMED : html`<span class="min-w-0 truncate text-[0.9rem]" data-step-name title="${step.name}">${step.name}</span>`}</span>${axis === null ? '' : renderTimeBar(step, axis)}${renderBar(step, maxUsd)}${axis === null ? '' : renderDuration(step, axis)}<span class="shrink-0 text-right text-[0.85rem] tabular-nums sm:w-44" data-step-cost>${renderCost(step)}</span></span>`;

const ROW = 'flex items-start rounded py-1.5 pr-2';

const INDENT_REM = 1.25;

const CHEVRON_REM = 1.125;

const indent = (depth: number, leaf: boolean): string =>
  `padding-left: ${0.5 + depth * INDENT_REM + (leaf ? CHEVRON_REM : 0)}rem`;

const renderStep = (step: Step, maxUsd: number, axis: Axis | null, depth: number): Rendered => {
  const attributes = html`data-step-kind="${step.kind}"${step.cacheMiss ? html` data-cache-miss` : ''}${step.retries === 0 ? '' : html` data-retried`}${axis !== null && isOpen(step, axis) ? html` data-step-open` : ''}`;
  const tone = step.cacheMiss ? ' bg-warning-soft' : '';
  if (step.children.length === 0) {
    return html`<li><div class="${ROW}${tone}" style="${indent(depth, true)}" data-step ${attributes}>${renderRow(step, maxUsd, axis)}</div></li>`;
  }
  return html`<li><details open data-step-branch>
      <summary class="${INLINE_DISCLOSURE} ${ROW} items-start! text-fg${tone}" style="${indent(depth, false)}" data-step ${attributes}>${renderRow(step, maxUsd, axis)}</summary>
      <ul class="m-0 list-none p-0">${step.children.map((child) => renderStep(child, maxUsd, axis, depth + 1))}</ul>
    </details></li>`;
};

const renderSummary = (trace: Trace, subscription: boolean): Rendered => {
  const rate = cacheHitRate(trace.usage);
  return html`<summary class="${DISCLOSURE} flex-wrap" data-trace-summary>
      <span class="${SECTION_TITLE}">Trace</span>
      <span class="${SUMMARY_FIGURE}">${trace.calls} ${trace.calls === 1 ? 'call' : 'calls'}</span>
      <span class="${SUMMARY_FIGURE}">${formatCost(trace.total)}${subscription ? ' list price' : ''}</span>
      ${rate === null ? '' : html`<span class="${SUMMARY_FIGURE}">${rate} cache hit</span>`}
      ${trace.misses === 0 ? '' : html`<span class="${BADGE} bg-warning-soft text-warning" data-badge="cache-miss" title="Calls whose cache read fell well below the previous call's prompt size">${trace.misses} ${trace.misses === 1 ? 'miss' : 'misses'}</span>`}
    </summary>`;
};

const SELECTED = 'bg-surface text-fg shadow-sm';

const VIEW_BUTTON = 'rounded px-2.5 py-1 text-[0.8rem] font-semibold disabled:cursor-not-allowed disabled:text-muted disabled:opacity-60';

const renderViews = (trace: Trace): Rendered =>
  html`<div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2">
      <span class="inline-flex gap-0.5 rounded-md bg-raised p-0.5" role="group" aria-label="Bars show">
        ${trace.timed ? html`<button type="button" class="${VIEW_BUTTON} ${SELECTED}" data-trace-view="time" aria-pressed="true">Time</button>` : html`<button type="button" class="${VIEW_BUTTON}" data-trace-view="time" disabled>Time</button>`}
        <button type="button" class="${VIEW_BUTTON}${trace.timed ? '' : ` ${SELECTED}`}" data-trace-view="cost" aria-pressed="${trace.timed ? 'false' : 'true'}">Cost</button>
      </span>
      ${trace.timed ? '' : html`<span class="text-[0.8rem] text-muted" data-trace-note>Recorded before step timings</span>`}
    </div>`;

export const renderTrace = (trace: Trace, subscription: boolean, live: boolean): Rendered => {
  if (trace.calls === 0) return '';
  const axis = axisOf(trace, live);
  return html`<details class="${BLOCK} mb-4 border-line" data-trace-section>
    ${renderSummary(trace, subscription)}
    <div class="${CARD} ${BAR_VIEWS} rounded-t-none border-x-0 border-b-0" data-trace data-bars="${axis === null ? 'cost' : 'time'}">
      ${renderViews(trace)}
      <ul class="m-0 list-none p-2">${trace.steps.map((step) => renderStep(step, trace.maxUsd, axis, 0))}</ul>
    </div>
  </details>`;
};
