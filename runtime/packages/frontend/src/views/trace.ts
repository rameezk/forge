import { html } from 'hono/html';
import { cacheHitRate, formatCost, formatStepDuration, formatTokens } from '../format.ts';
import type { Step, StepKind, Trace } from '../trace.ts';
import { BADGE, BLOCK, CARD, CODE, DISCLOSURE, ESTIMATED_BADGE, LABEL, LINK, NOT_RECORDED, PENDING, SECTION_TITLE, SUBSCRIPTION_BADGE, SUMMARY_FIGURE, type Rendered } from './shared.ts';
import { anchorId } from './transcript.ts';

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

const TRACK = 'block h-2 w-24 flex-none rounded-sm bg-raised';

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

const DURATION = 'shrink-0 text-right text-[0.85rem] tabular-nums text-muted w-14';

const axisOf = (trace: Trace, live: boolean): Axis | null =>
  trace.start === null || trace.end === null
    ? null
    : { start: trace.start, end: trace.end, span: Math.max(trace.end - trace.start, 1), live };

const BAR_VIEWS = '[&[data-bars=time]_[data-step-track]]:hidden [&[data-bars=cost]_[data-step-timeline]]:hidden';

const UNNAMED = html`<span class="min-w-0 truncate text-[0.9rem] italic text-muted" data-step-name>model not recorded</span>`;

const renderRow = (step: Step, maxUsd: number, axis: Axis | null): Rendered =>
  html`<span class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 @lg:gap-x-3"><span class="flex min-w-0 basis-full items-center gap-2 @lg:basis-0 @lg:flex-1">${step.cacheMiss ? CACHE_MISS_BADGE : ''}${kindBadge(step.kind)}${retryBadge(step.retries)}${step.name === '' ? UNNAMED : html`<span class="min-w-0 truncate text-[0.9rem]" data-step-name title="${step.name}">${step.name}</span>`}</span>${axis === null ? '' : renderTimeBar(step, axis)}${renderBar(step, maxUsd)}${axis === null ? '' : renderDuration(step, axis)}<span class="shrink-0 text-right text-[0.85rem] tabular-nums @lg:w-44" data-step-cost>${renderCost(step)}</span></span>`;

const ROW = 'flex items-start rounded py-1.5 pr-2 cursor-pointer hover:bg-raised aria-selected:bg-accent-soft focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent';

const INDENT_REM = 1.25;

const CHEVRON_REM = 1.125;

const indent = (depth: number, leaf: boolean): string =>
  `padding-left: ${0.5 + depth * INDENT_REM + (leaf ? CHEVRON_REM : 0)}rem`;

const TOGGLE = html`<span class="mr-1.5 inline-flex h-5 w-3 shrink-0 items-center justify-center text-[0.6rem] text-muted transition-transform group-open/branch:rotate-90" aria-hidden="true" data-step-toggle>▶</span>`;

interface Placement {
  key: string;
  depth: number;
  first: boolean;
  branch: string | null;
}

const renderStep = (step: Step, maxUsd: number, axis: Axis | null, { key, depth, first, branch }: Placement): Rendered => {
  const attributes = html`role="treeitem" aria-level="${depth + 1}" aria-selected="false" tabindex="${first ? 0 : -1}" data-step-key="${key}" data-step-kind="${step.kind}"${step.cacheMiss ? html` data-cache-miss` : ''}${step.retries === 0 ? '' : html` data-retried`}${axis !== null && isOpen(step, axis) ? html` data-step-open` : ''}`;
  const tone = step.cacheMiss ? ' bg-warning-soft' : '';
  if (step.children.length === 0) {
    return html`<li role="none"><div class="${ROW}${tone}" style="${indent(depth, true)}" data-step ${attributes}>${renderRow(step, maxUsd, axis)}</div></li>`;
  }
  const scope = step.kind === 'subagent' ? step.id : branch;
  return html`<li role="none"><details open class="group/branch" data-step-branch>
      <summary class="${ROW} list-none [&::-webkit-details-marker]:hidden text-fg${tone}" style="${indent(depth, false)}" aria-expanded="true" data-step ${attributes}>${TOGGLE}${renderRow(step, maxUsd, axis)}</summary>
      <ul class="m-0 list-none p-0" role="group">${step.children.map((child, index) => renderStep(child, maxUsd, axis, { key: `${key}-${index}`, depth: depth + 1, first: false, branch: scope }))}</ul>
    </details></li>`;
};

interface Placed {
  step: Step;
  key: string;
  branch: string | null;
}

const flatten = (steps: Step[], prefix: string, branch: string | null): Placed[] =>
  steps.flatMap((step, index) => {
    const key = `${prefix}${index}`;
    return [{ step, key, branch }, ...flatten(step.children, `${key}-`, step.kind === 'subagent' ? step.id : branch)];
  });

const TOKEN_LABELS = [
  ['cache-read', 'Cache read', 'cacheReadTokens'],
  ['cache-write', 'Cache write', 'cacheWriteTokens'],
  ['input', 'Input', 'inputTokens'],
  ['output', 'Output', 'outputTokens'],
] as const;

const DETAIL_TERM = 'text-muted';

const DETAIL_VALUE = 'm-0 min-w-0 break-words tabular-nums';

const renderTokens = (step: Step): Rendered => {
  const usage = step.generation?.usage ?? null;
  if (step.generation === null) return '';
  return html`<div class="flex flex-col gap-1.5" data-detail-tokens>
      <h3 class="${LABEL}">Tokens</h3>
      ${usage === null
        ? html`<p class="m-0 text-[0.85rem]">${NOT_RECORDED}</p>`
        : html`<dl class="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-1 text-[0.85rem]">${TOKEN_LABELS.map(
            ([name, label, field]) => html`<dt class="${DETAIL_TERM}">${label}</dt><dd class="${DETAIL_VALUE}" data-token="${name}">${formatTokens(usage[field])}</dd>`,
          )}</dl>`}
      ${step.cacheMiss
        ? html`<p class="m-0 rounded bg-warning-soft px-2 py-1 text-[0.8rem] text-warning" data-detail-cache-miss>Cache miss: this call's cache read fell well below the previous call's prompt size, so most of its prompt was not served from the cache.</p>`
        : ''}
    </div>`;
};

const renderMetadata = (step: Step, branch: string | null): Rendered => {
  const { generation } = step;
  const scope = generation === null ? branch : generation.subagent;
  const rows: Rendered[] = [];
  if (generation !== null) {
    rows.push(html`<dt class="${DETAIL_TERM}">Generation</dt><dd class="${DETAIL_VALUE}" data-detail-generation>${generation.generationId ?? NOT_RECORDED}</dd>`);
  } else if (step.id !== null) {
    rows.push(html`<dt class="${DETAIL_TERM}">${step.kind === 'subagent' ? 'Subagent' : 'Tool call'}</dt><dd class="${DETAIL_VALUE}" data-detail-id>${step.id}</dd>`);
  }
  if (scope !== null && step.kind !== 'subagent') {
    rows.push(html`<dt class="${DETAIL_TERM}">Subagent</dt><dd class="${DETAIL_VALUE}" data-detail-subagent>${scope}</dd>`);
  }
  if (generation !== null) {
    rows.push(html`<dt class="${DETAIL_TERM}">Model</dt><dd class="${DETAIL_VALUE}" data-detail-model>${generation.servedModel ?? NOT_RECORDED}</dd>`);
    rows.push(html`<dt class="${DETAIL_TERM}">Provider</dt><dd class="${DETAIL_VALUE}" data-detail-provider>${generation.provider ?? NOT_RECORDED}</dd>`);
  }
  if (step.cost !== null || step.kind === 'subagent') {
    rows.push(html`<dt class="${DETAIL_TERM}">Cost</dt><dd class="${DETAIL_VALUE}" data-detail-cost>${renderCost(step)}</dd>`);
  }
  return html`<dl class="m-0 grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-6 gap-y-1 text-[0.85rem]" data-detail-meta>${rows}</dl>`;
};

const renderExcerpt = (label: string, name: string, text: string | null, failed = false): Rendered =>
  html`<div class="flex flex-col gap-1.5">
      <h3 class="${LABEL}">${label}</h3>
      ${text === null
        ? html`<p class="m-0 text-[0.85rem]">${NOT_RECORDED}</p>`
        : html`<pre class="${CODE}${failed ? ' text-error' : ''}" data-detail-${name}>${text}</pre>`}
    </div>`;

const renderExcerpts = (step: Step): Rendered => {
  if (step.kind === 'tool' || step.kind === 'subagent') {
    return html`${renderExcerpt(step.kind === 'tool' ? 'Command' : 'Task', 'request', step.request)}${renderExcerpt(step.failed ? 'Error' : step.kind === 'tool' ? 'Output' : 'Report', 'response', step.response, step.failed)}`;
  }
  return html`${renderExcerpt('Request', 'request', step.request)}${renderExcerpt('Response', 'response', step.response)}`;
};

const transcriptHref = (runId: string, anchor: number | null): string =>
  `/runs/${encodeURIComponent(runId)}/transcript${anchor === null ? '' : `#${anchorId(anchor)}`}`;

const renderDetail = ({ step, key, branch }: Placed, runId: string): Rendered =>
  html`<section class="flex flex-col gap-4" hidden data-step-detail="${key}" data-step-detail-kind="${step.kind}">
      <header class="flex min-w-0 flex-wrap items-center gap-2">${kindBadge(step.kind)}${retryBadge(step.retries)}${step.name === '' ? UNNAMED : html`<span class="min-w-0 break-words text-[0.9rem] font-semibold">${step.name}</span>`}</header>
      ${renderMetadata(step, branch)}
      ${renderTokens(step)}
      ${renderExcerpts(step)}
      <a href="${transcriptHref(runId, step.anchor)}" class="${LINK} text-[0.9rem]" data-detail-transcript>Open in the full transcript</a>
    </section>`;

const renderDetails = (steps: Placed[], runId: string): Rendered =>
  html`<aside class="${CARD} min-w-0 p-4 @2xl:sticky @2xl:top-2 @2xl:self-start" aria-label="Step details" data-trace-detail>
      <p class="m-0 text-[0.9rem] text-muted" data-detail-empty>Select a step to see its details.</p>
      ${steps.map((entry) => renderDetail(entry, runId))}
    </aside>`;

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

export const renderTrace = (trace: Trace, subscription: boolean, runId: string, live: boolean): Rendered => {
  if (trace.calls === 0) return '';
  const axis = axisOf(trace, live);
  return html`<details class="${BLOCK} mb-4 border-line" data-trace-section>
    ${renderSummary(trace, subscription)}
    <div class="${BAR_VIEWS} @container flex flex-col gap-3 rounded-t-none border-t border-line p-0" data-trace data-bars="${axis === null ? 'cost' : 'time'}">
      <div class="grid min-w-0 gap-3 @2xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div class="${CARD} @container min-w-0 rounded-t-none">
          ${renderViews(trace)}
          <ul class="m-0 list-none p-2" role="tree" aria-label="Trace steps">${trace.steps.map((step, index) => renderStep(step, trace.maxUsd, axis, { key: `${index}`, depth: 0, first: index === 0, branch: null }))}</ul>
        </div>
        ${renderDetails(flatten(trace.steps, '', null), runId)}
      </div>
    </div>
  </details>`;
};
