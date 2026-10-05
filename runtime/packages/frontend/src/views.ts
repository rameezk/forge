import { html, raw } from 'hono/html';
import { isGithubRepository, isGithubUrl, ticketKey } from '@forge/shared';
import type { HtmlEscapedString } from 'hono/utils/html';
import type {
  DispatchFailure,
  DispatchRecord,
  DispatchState,
  GenerationRecord,
  HarnessEvent,
  CompactionEvent,
  MessageEvent,
  RepositoryFrontier,
  ResultEvent,
  RetryEvent,
  RunRecord,
  RunStatus,
  RunTicket,
  SpecRef,
  Ticket,
  ToolCallEvent,
  ToolResultEvent,
} from '@forge/shared';
import {
  cacheHitRate,
  formatCost,
  formatDate,
  formatDuration,
  formatStarted,
  formatTime,
  formatTokens,
  formatTotal,
  pendingCount,
  totalCost,
} from './format.ts';
import { cacheMisses, isCall, promptTokens } from './calls.ts';
import { renderMarkdown } from './markdown.ts';
import { DEFAULT_EFFORT, type CallEfforts, type RequestRecordView, type ToolDefinition, type WorkloadContext } from './request-record.ts';

type Rendered = HtmlEscapedString | Promise<HtmlEscapedString> | '';

type Page = 'runs' | 'work';

const NAV: { page: Page; href: string; label: string }[] = [
  { page: 'runs', href: '/', label: 'Runs' },
  { page: 'work', href: '/work', label: 'Work' },
];

export const NAV_PAGES: ReadonlySet<string> = new Set(NAV.map(({ href }) => href));

export const isSettled = (run: Pick<RunRecord, 'endTime' | 'costStatus'>): boolean =>
  run.endTime !== null && run.costStatus !== 'pending';

export interface AssetHrefs {
  stylesheet: string;
  logo: string;
  idiomorph: string;
  client: string;
}

const FOCUS_RINGS = '[&_:where(:focus-visible)]:outline-2 [&_:where(:focus-visible)]:outline-offset-2 [&_:where(:focus-visible)]:outline-accent';
const PAGE_TITLE = 'm-0 mb-3 text-xl font-bold';
const SECTION_TITLE = 'm-0 text-[1.1rem] font-bold';
const EMPTY = 'm-0 text-muted';
const LINK = 'rounded-sm font-medium text-accent-text no-underline hover:underline';
const CALLOUT = 'm-0 rounded-lg px-4 py-2.5 break-words';
const ERROR_CALLOUT = `${CALLOUT} bg-error-soft text-error`;
const WARNING_CALLOUT = `${CALLOUT} bg-warning-soft text-warning`;
const CARD = 'overflow-x-auto rounded-lg border border-line bg-surface';
const TABLE = 'w-full border-collapse text-[0.9rem]';
const TH = 'whitespace-nowrap border-b border-line bg-raised px-3.5 py-2.5 text-left text-[0.7rem] font-semibold uppercase tracking-[0.06em] text-fg';
const TD = 'border-t border-line px-3.5 py-2.5 align-baseline';
const ROW = 'hover:bg-bg';
const NUMERIC_WRAPPING = 'text-right tabular-nums';
const NUMERIC = `${NUMERIC_WRAPPING} whitespace-nowrap`;
const PENDING = 'font-normal italic text-muted';
const NAV_LINK = 'border-b-2 py-1.5 text-[0.9rem] no-underline';
const POLLED = 'ml-auto text-sm text-muted';
const LIVE_INDICATOR = "ml-auto inline-flex items-center gap-1.5 text-xs text-muted before:size-1.5 before:rounded-full before:bg-current before:content-[''] data-[state=live]:before:bg-success data-[state=reconnecting]:before:bg-warning";

const externalLink = (href: string, label: string): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<a href="${href}" target="_blank" rel="noopener noreferrer" class="${LINK}">${label}</a>`;

const navLink = (href: string, label: string, current: boolean): HtmlEscapedString | Promise<HtmlEscapedString> =>
  current
    ? html`<a href="${href}" aria-current="page" class="${NAV_LINK} border-accent font-semibold text-fg">${label}</a>`
    : html`<a href="${href}" class="${NAV_LINK} border-transparent text-muted hover:text-fg">${label}</a>`;

const renderHeader = (
  current: Page | null,
  live: boolean,
  assets: AssetHrefs,
): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<header class="border-b border-line bg-surface">
    <div class="mx-auto flex max-w-6xl items-center gap-6 px-4 py-2">
      <a href="/" data-brand class="flex items-center gap-2 rounded-sm text-[1.05rem] font-bold tracking-tight text-fg no-underline"><img src="${assets.logo}" alt="" width="28" height="28" class="size-7" />Forge</a>
      <nav class="flex gap-4">
        ${NAV.map(({ page, href, label }) => navLink(href, label, page === current))}
      </nav>
      ${live ? html`<span id="live" role="status" data-live hidden class="${LIVE_INDICATOR}"></span>` : ''}
    </div>
  </header>`;

const layout = (
  title: string,
  current: Page | null,
  live: boolean,
  assets: AssetHrefs,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<!doctype html>
    <html lang="en" class="scheme-light-dark">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} | Forge</title>
        <link rel="icon" type="image/svg+xml" href="${assets.logo}" />
        <link rel="stylesheet" href="${assets.stylesheet}" />
        <script src="${assets.idiomorph}" defer></script>
        <script src="${assets.client}" defer></script>
      </head>
      <body class="bg-bg text-[15px] text-fg ${FOCUS_RINGS}">
        ${renderHeader(current, live, assets)}
        <main class="mx-auto max-w-6xl px-4 py-8">${body}</main>
      </body>
    </html>`;

const BADGE = 'shrink-0 rounded px-1.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-[0.05em]';

const UNCONFIRMED_BADGE = html`<span class="${BADGE} ml-1.5 bg-warning-soft text-warning" data-badge="unconfirmed" title="forge could not confirm OpenRouter's billed cost for every generation, so this may not be the whole cost">unconfirmed</span>`;

const ESTIMATED_BADGE = html`<span class="${BADGE} ml-1.5 bg-line text-fg" data-badge="estimated" title="Includes forge's estimate at OpenRouter's list price for generations not yet billed, replaced as generations are billed">estimated</span>`;

const PENDING_BADGE = html`<span class="${BADGE} ml-1.5 bg-line text-fg" data-badge="pending" title="Billed by OpenRouter so far. Rises as the run's generations are billed, trailing them by a minute or two.">pending</span>`;

type Cost = Pick<RunRecord, 'costStatus' | 'costUsd' | 'costEstimated'>;

const costBadge = (run: Cost): Rendered => {
  if (run.costEstimated) return ESTIMATED_BADGE;
  return run.costStatus === 'pending' ? PENDING_BADGE : '';
};

const renderCost = (run: Cost): Rendered => {
  if (run.costStatus === 'pending' && !run.costEstimated && run.costUsd === 0) {
    return html`<span class="${PENDING}">pending</span>`;
  }
  const badge = costBadge(run);
  return html`${formatCost(run.costUsd)}${badge === '' ? '' : html`<wbr>${badge}`}${run.costStatus === 'unconfirmed' ? html`<wbr>${UNCONFIRMED_BADGE}` : ''}`;
};

const PILL = "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold before:size-1.5 before:rounded-full before:bg-current before:content-['']";

const STATUS_TONE: Record<RunStatus, string> = {
  success: 'bg-success-soft text-success',
  error: 'bg-error-soft text-error',
  running: 'bg-raised text-fg',
  interrupted: 'bg-warning-soft text-warning',
};

const renderStatus = (status: RunStatus): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<span class="${PILL} ${STATUS_TONE[status]}" data-status="${status}">${status}</span>`;

const renderTimestamp = (iso: string): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<time datetime="${iso}" title="${iso}" class="whitespace-nowrap">${formatStarted(iso)}</time>`;

const renderClock = (iso: string): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<time datetime="${iso}" title="${iso}">${formatTime(iso)}</time>`;

const renderDate = (iso: string): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<time datetime="${iso}" title="${iso}" class="whitespace-nowrap">${formatDate(iso)}</time>`;

const renderRunTicket = (ticket: RunTicket | null): Rendered =>
  ticket === null
    ? ''
    : html`<span class="text-muted">${ticket.repository}</span> ${isGithubUrl(ticket.url)
        ? externalLink(ticket.url, `#${ticket.number}`)
        : html`#${ticket.number}`}`;

const NOT_RECORDED = html`<span class="${PENDING}">not recorded</span>`;

const renderTokens = (run: Pick<RunRecord, 'inputTokens' | 'outputTokens'>): string =>
  `${formatTokens(run.inputTokens)} in / ${formatTokens(run.outputTokens)} out`;

const renderCache = (run: RunRecord): Rendered =>
  run.cacheReadTokens === null || run.cacheWriteTokens === null
    ? NOT_RECORDED
    : html`${formatTokens(run.cacheReadTokens)} read / ${formatTokens(run.cacheWriteTokens)} write`;

const renderCacheHitRate = (run: RunRecord): Rendered => {
  const rate = cacheHitRate(run);
  return rate === null ? NOT_RECORDED : html`${rate}`;
};

const renderProviders = (run: RunRecord, generations: GenerationRecord[]): Rendered => {
  const providers = [
    ...new Set(generations.flatMap(({ provider }) => (provider === null ? [] : [provider]))),
  ];
  if (providers.length > 0) {
    return html`${providers.join(', ')}`;
  }
  const settling =
    run.costStatus === 'pending' ||
    generations.some(({ billedCostUsd, givenUpAt }) => billedCostUsd === null && givenUpAt === null);
  return settling ? html`<span class="${PENDING}">pending</span>` : NOT_RECORDED;
};

const BILLED_BADGE = html`<span class="${BADGE} ml-1.5 bg-line text-fg" data-badge="billed" title="The cost OpenRouter billed for this generation">billed</span>`;

const callCost = ({ billedCostUsd, estimatedCostUsd }: GenerationRecord): Rendered => {
  if (billedCostUsd !== null) return html`${formatCost(billedCostUsd)}<wbr>${BILLED_BADGE}`;
  if (estimatedCostUsd !== null) return html`${formatCost(estimatedCostUsd)}<wbr>${ESTIMATED_BADGE}`;
  return html`<span class="${PENDING}">pending</span>`;
};

const optionalTokens = (count: number | null): string => (count === null ? '' : formatTokens(count));

const CACHE_MISS_BADGE = html`<span class="${BADGE} mr-1.5 bg-warning-soft text-warning" data-badge="cache-miss" title="This call's cache read fell well below the previous call's prompt size, so most of its prompt was not served from the cache">miss</span>`;

const renderCall = (
  generation: GenerationRecord,
  miss: boolean,
  effort: string | undefined,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const { usage } = generation;
  return html`<tr class="${miss ? 'bg-warning-soft' : ROW}" data-call${miss ? html` data-cache-miss` : ''}>
    <td class="${TD} whitespace-nowrap" data-time>${renderClock(generation.createdAt)}</td>
    <td class="${TD} whitespace-nowrap" data-provider>${generation.provider ?? ''}</td>
    <td class="${TD} wrap-anywhere" data-served-model>${generation.servedModel ?? ''}</td>
    <td class="${TD} whitespace-nowrap" data-effort>${effort ?? ''}</td>
    <td class="${TD} ${NUMERIC}" data-prompt>${usage === null ? '' : formatTokens(promptTokens(usage))}</td>
    <td class="${TD} ${NUMERIC}" data-cache-read>${miss ? CACHE_MISS_BADGE : ''}${usage === null ? '' : formatTokens(usage.cacheReadTokens)}</td>
    <td class="${TD} ${NUMERIC}" data-cache-write>${usage === null ? '' : formatTokens(usage.cacheWriteTokens)}</td>
    <td class="${TD} ${NUMERIC}" data-output>${usage === null ? '' : formatTokens(usage.outputTokens)}</td>
    <td class="${TD} ${NUMERIC}" data-reasoning>${optionalTokens(generation.reasoningTokens)}</td>
    <td class="${TD} ${NUMERIC_WRAPPING}" data-cost>${callCost(generation)}</td>
  </tr>`;
};

const sentEfforts = (calls: GenerationRecord[], efforts: CallEfforts): (string | undefined)[] => {
  const seen = new Map<string | null, number>();
  return calls.map(({ subagent }) => {
    const index = seen.get(subagent) ?? 0;
    seen.set(subagent, index + 1);
    return efforts.get(subagent)?.[index];
  });
};

const renderCalls = (calls: GenerationRecord[], efforts: (string | undefined)[]): Rendered => {
  if (calls.length === 0) return '';
  const misses = cacheMisses(calls);
  return html`<h2 class="${SECTION_TITLE} mt-8 mb-3">Calls</h2>
    <div class="${CARD}" data-calls>
      <table class="${TABLE}">
        <thead>
          <tr>
            <th class="${TH}">Time</th>
            <th class="${TH}">Provider</th>
            <th class="${TH}">Served model</th>
            <th class="${TH}">Effort</th>
            <th class="${TH} text-right">Prompt</th>
            <th class="${TH} text-right">Cache read</th>
            <th class="${TH} text-right">Cache write</th>
            <th class="${TH} text-right">Output</th>
            <th class="${TH} text-right">Reasoning</th>
            <th class="${TH} text-right">Cost</th>
          </tr>
        </thead>
        <tbody>${calls.map((call, index) => renderCall(call, misses.has(call), efforts[index]))}</tbody>
      </table>
    </div>`;
};

const configuredEffort = (run: Pick<RunRecord, 'reasoningEffort'>): string =>
  run.reasoningEffort ?? DEFAULT_EFFORT;

const summaryEffort = (run: Pick<RunRecord, 'reasoningEffort'>, sent: (string | undefined)[]): string =>
  sent.some((effort) => effort !== undefined && effort !== configuredEffort(run))
    ? 'varied'
    : configuredEffort(run);

const renderTotal = (runs: RunRecord[]): Rendered => {
  const pending = pendingCount(runs);
  return html`${formatTotal(totalCost(runs))}${pending === 0
    ? ''
    : html` <span class="${PENDING}">+${pending} pending</span>`}`;
};

export const renderList = (
  runs: RunRecord[],
  assets: AssetHrefs,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const body =
    runs.length === 0
      ? html`<h1 class="${PAGE_TITLE}">Workloads</h1>
          <p class="${EMPTY}">No workloads have run yet.</p>`
      : html`<h1 class="${PAGE_TITLE}">Workloads</h1>
          <div class="${CARD}">
            <table class="${TABLE}">
              <thead>
                <tr>
                  <th class="${TH}">Worker</th>
                  <th class="${TH}">Ticket</th>
                  <th class="${TH}">Model</th>
                  <th class="${TH}">Effort</th>
                  <th class="${TH}">Started</th>
                  <th class="${TH}">Duration</th>
                  <th class="${TH}">Status</th>
                  <th class="${TH} text-right">Cache hit</th>
                  <th class="${TH} text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                ${runs.map(
                  (run) => html`<tr class="${ROW}" data-run="${run.id}">
                    <td class="${TD} whitespace-nowrap"><a href="/runs/${run.id}" class="${LINK}">${run.worker}</a></td>
                    <td class="${TD} whitespace-nowrap tabular-nums" data-run-ticket>${renderRunTicket(run.ticket)}</td>
                    <td class="${TD} wrap-anywhere text-muted">${run.model}</td>
                    <td class="${TD} whitespace-nowrap" data-effort>${configuredEffort(run)}</td>
                    <td class="${TD}">${renderTimestamp(run.startTime)}</td>
                    <td class="${TD} whitespace-nowrap">${formatDuration(run.startTime, run.endTime)}</td>
                    <td class="${TD}">${renderStatus(run.status)}</td>
                    <td class="${TD} ${NUMERIC}" data-cache-hit>${renderCacheHitRate(run)}</td>
                    <td class="${TD} ${NUMERIC_WRAPPING}" data-cost>${renderCost(run)}</td>
                  </tr>`,
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td colspan="8" class="${TD} font-semibold">Total</td>
                  <td class="${TD} ${NUMERIC} font-semibold">${renderTotal(runs)}</td>
                </tr>
              </tfoot>
            </table>
          </div>`;
  return layout('Workloads', 'runs', true, assets, body);
};

const BLOCK = 'rounded-lg border bg-surface';
const STACK = 'flex flex-col gap-3';
const LABEL = 'm-0 text-xs font-semibold uppercase tracking-[0.05em] text-muted';
const PROSE = 'm-0 whitespace-pre-wrap break-words font-sans';
const PATH = 'm-0 whitespace-pre-wrap break-words font-mono text-[0.85rem]';
const CODE = 'm-0 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-raised px-3 py-2.5 font-mono text-[0.8rem] leading-relaxed text-fg';

const MESSAGE_TONE = new Map([
  ['prompt', { border: 'border-accent/50', label: 'text-accent-text' }],
  ['report', { border: 'border-fg/35', label: 'text-muted' }],
  ['error', { border: 'border-error', label: 'text-error' }],
]);

const DEFAULT_TONE = { border: 'border-line', label: 'text-muted' };

const renderText = (
  kind: string,
  text: string,
  textClass: string = PROSE,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const tone = MESSAGE_TONE.get(kind) ?? DEFAULT_TONE;
  return html`<article class="${BLOCK} ${tone.border} px-4 py-3" data-message="${kind}">
    <header class="${LABEL} mb-1.5 ${tone.label}">${kind}</header>
    <pre class="${textClass}">${text}</pre>
  </article>`;
};

const MARKDOWN = [
  'prose prose-sm max-w-none break-words',
  '[--tw-prose-body:var(--color-fg)] [--tw-prose-headings:var(--color-fg)] [--tw-prose-bold:var(--color-fg)]',
  '[--tw-prose-code:var(--color-fg)] [--tw-prose-pre-code:var(--color-fg)] [--tw-prose-quotes:var(--color-fg)]',
  '[--tw-prose-lead:var(--color-muted)] [--tw-prose-counters:var(--color-muted)] [--tw-prose-bullets:var(--color-muted)] [--tw-prose-captions:var(--color-muted)]',
  '[--tw-prose-hr:var(--color-line)] [--tw-prose-quote-borders:var(--color-line)] [--tw-prose-th-borders:var(--color-line)] [--tw-prose-td-borders:var(--color-line)]',
  '[--tw-prose-links:var(--color-accent-text)] [--tw-prose-pre-bg:var(--color-raised)]',
  'prose-pre:overflow-x-auto prose-table:my-0 [&>div]:my-6 [&>:first-child]:mt-0 [&>:last-child]:mb-0',
  'prose-th:min-w-32 prose-td:min-w-32',
  'prose-code:before:content-none prose-code:after:content-none',
  '[&_blockquote_p]:before:content-none [&_blockquote_p]:after:content-none',
].join(' ');

const renderCard = (
  kind: string,
  meta: Rendered,
  body: Rendered,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const tone = MESSAGE_TONE.get(kind) ?? DEFAULT_TONE;
  return html`<article class="${BLOCK} ${tone.border} px-4 py-3" data-message="${kind}">
    <header class="${LABEL} mb-1.5 flex items-baseline gap-3 ${tone.label}">${kind === 'prompt' ? 'Prompt' : kind}${meta}</header>
    ${body}
  </article>`;
};

const renderMarkdownBody = (text: string): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<div class="${MARKDOWN}" data-markdown>${raw(renderMarkdown(text))}</div>`;

const renderProse = (
  kind: string,
  text: string,
): HtmlEscapedString | Promise<HtmlEscapedString> => renderCard(kind, '', renderMarkdownBody(text));

const MESSAGE_META = 'ml-auto shrink-0 whitespace-nowrap text-xs font-normal normal-case tracking-normal text-muted tabular-nums';

const renderMessageMeta = ({ timestamp, stopReason }: MessageEvent): Rendered => {
  if (timestamp === undefined && stopReason === undefined) return '';
  const parts = [
    timestamp === undefined ? '' : html`<time datetime="${timestamp}" title="${timestamp}">${formatTime(timestamp)}</time>`,
    stopReason === undefined ? '' : html`<span data-stop-reason>${stopReason}</span>`,
  ].filter((part) => part !== '');
  return html`<span class="${MESSAGE_META}" data-message-meta>${parts.map((part, index) => (index === 0 ? part : html` · ${part}`))}</span>`;
};

const INLINE_DISCLOSURE = `cursor-pointer list-none items-center gap-1.5 rounded-sm text-xs text-muted hover:text-fg [&::-webkit-details-marker]:hidden before:inline-block before:w-3 before:shrink-0 before:text-center before:text-[0.6rem] before:transition-transform before:content-['▶'] [[open]>&]:before:rotate-90`;

const THINKING = 'm-0 mt-1.5 whitespace-pre-wrap break-words border-l-2 border-line pl-3 font-sans text-[0.85rem] text-muted';

const renderThinking = (thinking: string | undefined): Rendered =>
  thinking === undefined
    ? ''
    : html`<details class="mt-2" data-thinking>
        <summary class="${INLINE_DISCLOSURE} inline-flex font-semibold">Thinking</summary>
        <pre class="${THINKING}">${thinking}</pre>
      </details>`;

const firstLine = (text: string): string =>
  text.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? '';

const renderThinkingPreview = (thinking: string): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<details class="group/thinking" data-thinking data-thinking-preview>
    <summary class="${INLINE_DISCLOSURE} flex w-full"><span class="min-w-0 truncate italic text-muted group-open/thinking:hidden" data-thinking-first-line>${firstLine(thinking)}</span><span class="hidden font-semibold group-open/thinking:inline">Thinking</span></summary>
    <pre class="${THINKING}">${thinking}</pre>
  </details>`;

const renderMessageError = (error: string | undefined): Rendered =>
  error === undefined
    ? ''
    : html`<p class="${ERROR_CALLOUT} mt-2 whitespace-pre-wrap text-[0.9rem]" data-message-error>${error}</p>`;

const isThinkingOnly = (event: MessageEvent): event is MessageEvent & { thinking: string } =>
  event.text === '' && event.thinking !== undefined;

const messageBody = (event: MessageEvent): Rendered => {
  if (isThinkingOnly(event)) return renderThinkingPreview(event.thinking);
  if (event.text === '' && event.error !== undefined) return '';
  return html`${renderMarkdownBody(event.text)}${renderThinking(event.thinking)}`;
};

const renderMessage = (
  kind: string,
  event: MessageEvent,
): HtmlEscapedString | Promise<HtmlEscapedString> =>
  renderCard(kind, renderMessageMeta(event), html`${messageBody(event)}${renderMessageError(event.error)}`);

const renderReport = (
  report: ToolResultEvent,
  message: MessageEvent | undefined,
): HtmlEscapedString | Promise<HtmlEscapedString> =>
  message === undefined ? renderProse('report', report.text) : renderMessage('report', message);

const SUMMARY_KEYS = ['command', 'path', 'pattern', 'task'];

const summaryText = (args: unknown): unknown => {
  if (typeof args !== 'object' || args === null) {
    return args;
  }
  const fields = args as Record<string, unknown>;
  const values = [...SUMMARY_KEYS.map((key) => fields[key]), ...Object.values(fields)];
  return values.find((value) => typeof value === 'string');
};

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

const argumentSummary = (args: unknown): string => {
  const summary = summaryText(args);
  return typeof summary === 'string' ? oneLine(summary) : '';
};

const prettyArguments = (args: unknown): string =>
  typeof args === 'string' ? args : (JSON.stringify(args, null, 2) ?? '');

type ToolResults = Map<ToolCallEvent, ToolResultEvent>;

const toolKey = ({ id, subagent }: ToolCallEvent | ToolResultEvent): string =>
  JSON.stringify([subagent ?? null, id]);

const toolResults = (events: HarnessEvent[]): ToolResults => {
  const unanswered = new Map<string, ToolCallEvent[]>();
  const results: ToolResults = new Map();
  for (const event of events) {
    if (event.type === 'tool_call') {
      const key = toolKey(event);
      unanswered.set(key, [...(unanswered.get(key) ?? []), event]);
    } else if (event.type === 'tool_result') {
      const call = unanswered.get(toolKey(event))?.shift();
      if (call !== undefined) {
        results.set(call, event);
      }
    }
  }
  return results;
};

const toolName = (name: string, failed: boolean): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<span class="min-w-0 max-w-[70%] truncate font-mono text-[0.85rem] font-semibold ${failed ? 'text-error' : 'text-fg'}" data-tool-name title="${name}">${name}</span>`;

const ERROR_BADGE = html`<span class="${BADGE} ml-auto bg-error-soft text-error" data-badge="error">error</span>`;

const DISCLOSURE = `flex cursor-pointer list-none items-center gap-2.5 rounded-lg px-4 py-2.5 [&::-webkit-details-marker]:hidden before:inline-block before:w-3 before:shrink-0 before:text-center before:text-[0.65rem] before:text-muted before:transition-transform before:content-['▶'] [[open]>&]:before:rotate-90 focus-visible:-outline-offset-2`;

const SUMMARY_CODE = 'min-w-0 flex-1 truncate font-mono text-[0.85rem] text-muted';

const renderToolCall = (
  call: ToolCallEvent,
  result: ToolResultEvent | undefined,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const summary = argumentSummary(call.arguments);
  const failed = result?.isError === true;
  return html`<details class="${BLOCK} ${failed ? 'border-error' : 'border-line'}" data-tool-call${failed ? html` data-failed open` : ''}>
    <summary class="${DISCLOSURE}">
      ${toolName(call.name, failed)}
      <code class="${SUMMARY_CODE}" title="${summary}">${summary}</code>
      ${failed ? ERROR_BADGE : ''}
    </summary>
    <div class="flex flex-col gap-1.5 border-t border-line px-4 pt-3 pb-4">
      <header class="${LABEL}">Arguments</header>
      <pre class="${CODE}">${prettyArguments(call.arguments)}</pre>
      <header class="${LABEL} mt-2">Result</header>
      ${result === undefined
        ? html`<p class="${EMPTY}">No result recorded.</p>`
        : html`<pre class="${CODE}">${result.text}</pre>`}
    </div>
  </details>`;
};

const EVENT_NOTE = 'm-0 border-l-2 py-0.5 pl-3 text-[0.85rem] break-words';

const formatDelay = (ms: number): string => `${ms / 1000}s`;

const retryLabel = ({ attempt, maxAttempts }: RetryEvent): string => {
  if (attempt === null) return 'Retry';
  return maxAttempts === null ? `Retry ${attempt}` : `Retry ${attempt} of ${maxAttempts}`;
};

const renderRetry = (event: RetryEvent): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<p class="${EVENT_NOTE} border-warning text-warning" data-event="retry">${retryLabel(event)}${event.delayMs === null
    ? ''
    : ` in ${formatDelay(event.delayMs)}`}${event.error === null ? '' : `: ${event.error}`}</p>`;

const compactedTokens = ({ tokensBefore, tokensAfter }: CompactionEvent): string => {
  if (tokensBefore === null) return '';
  return tokensAfter === null
    ? `: from ${formatTokens(tokensBefore)} tokens`
    : `: ${formatTokens(tokensBefore)} → ${formatTokens(tokensAfter)} tokens`;
};

const renderCompaction = (event: CompactionEvent): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const reason = event.reason === null ? '' : ` (${event.reason})`;
  if (event.error !== null) {
    return html`<p class="${EVENT_NOTE} border-error text-error" data-event="compaction">Compaction failed${reason}: ${event.error}</p>`;
  }
  const label = `Compacted context${reason}${compactedTokens(event)}`;
  if (event.summary === null) {
    return html`<p class="${EVENT_NOTE} border-line text-muted" data-event="compaction">${label}</p>`;
  }
  return html`<details class="${BLOCK} border-line" data-event="compaction">
    <summary class="${DISCLOSURE} text-[0.85rem] text-muted">${label}</summary>
    <div class="border-t border-line px-4 pt-3 pb-4"><pre class="${PROSE} text-[0.85rem]">${event.summary}</pre></div>
  </details>`;
};

const renderEvent = (
  event: HarnessEvent,
  results: ToolResults,
): Rendered => {
  switch (event.type) {
    case 'message':
      return renderMessage(event.role, event);
    case 'tool_call':
      return renderToolCall(event, results.get(event));
    case 'tool_result':
      return '';
    case 'retry':
      return renderRetry(event);
    case 'compaction':
      return renderCompaction(event);
    case 'result':
      return html`<article class="${BLOCK} ${event.status === 'error' ? 'border-error' : 'border-line'} flex items-baseline gap-2.5 px-4 py-3" data-message="result">${renderStatus(event.status)}${event.error === null
        ? ''
        : html`<span class="min-w-0 break-words">${event.error}</span>`}</article>`;
  }
};

interface SubagentGroup {
  type: 'subagent';
  scope: string;
  call?: ToolCallEvent;
  events: ScopedEvent[];
}

type ScopedEvent = Exclude<HarnessEvent, ResultEvent>;

type TranscriptEntry = HarnessEvent | SubagentGroup;

const isToolCall = (entry: TranscriptEntry | undefined): boolean =>
  entry?.type === 'tool_call' ||
  (entry?.type === 'subagent' && entry.call !== undefined);

const isToolOnlyPreamble = (
  entry: TranscriptEntry,
  next: TranscriptEntry | undefined,
): boolean =>
  entry.type === 'message' &&
  entry.role === 'assistant' &&
  entry.text.length === 0 &&
  entry.thinking === undefined &&
  entry.error === undefined &&
  isToolCall(next);

const withoutToolOnlyPreambles = <T extends TranscriptEntry>(entries: T[]): T[] =>
  entries.filter((entry, index) => !isToolOnlyPreamble(entry, entries[index + 1]));

const nestSubagents = (events: HarnessEvent[]): TranscriptEntry[] => {
  const calls = new Map<string, { call: ToolCallEvent; index: number }>();
  const groups = new Map<string, SubagentGroup>();
  const entries: TranscriptEntry[] = [];
  for (const event of events) {
    if (event.type === 'result' || event.subagent === undefined) {
      if (event.type === 'tool_call') {
        calls.set(event.id, { call: event, index: entries.length });
        groups.delete(event.id);
      }
      entries.push(event);
      continue;
    }
    let group = groups.get(event.subagent);
    if (group === undefined) {
      const spawner = calls.get(event.subagent);
      group = spawner === undefined
        ? { type: 'subagent', scope: event.subagent, events: [] }
        : { type: 'subagent', scope: event.subagent, call: spawner.call, events: [] };
      groups.set(event.subagent, group);
      if (spawner === undefined) {
        entries.push(group);
      } else {
        entries[spawner.index] = group;
      }
    }
    group.events.push(event);
  }
  return entries;
};

const messageCount = (events: ScopedEvent[]): string => {
  const messages = events.filter((event) => event.type === 'message').length;
  return `${messages} ${messages === 1 ? 'message' : 'messages'}`;
};

const reportMessage = (
  events: ScopedEvent[],
  report: ToolResultEvent | undefined,
): MessageEvent | undefined => {
  const last = events.findLast(
    (event): event is MessageEvent => event.type === 'message' && event.role === 'assistant',
  );
  return last !== undefined && last.text === report?.text ? last : undefined;
};

const argumentFields = (args: unknown): Record<string, unknown> =>
  typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};

const taskText = (args: unknown): string => {
  const { task } = argumentFields(args);
  return typeof task === 'string' ? task : prettyArguments(args);
};

interface SubagentContext {
  results: ToolResults;
  generations: GenerationRecord[];
  runStatus: RunStatus;
}

const subagentStatus = (
  report: ToolResultEvent | undefined,
  runStatus: RunStatus,
): RunStatus => {
  if (report !== undefined) return report.isError ? 'error' : 'success';
  return runStatus === 'running' || runStatus === 'interrupted' ? runStatus : 'error';
};

const subagentCost = (
  scope: string,
  generations: GenerationRecord[],
  runStatus: RunStatus,
): Cost => {
  const own = generations.filter((generation) => generation.subagent === scope);
  const awaiting = own.filter(
    (generation) => generation.billedCostUsd === null && generation.givenUpAt === null,
  );
  const costEstimated =
    awaiting.length > 0 &&
    awaiting.every((generation) => generation.estimatedCostUsd !== null);
  const billed = own.reduce((sum, generation) => sum + (generation.billedCostUsd ?? 0), 0);
  const costUsd = costEstimated
    ? awaiting.reduce((sum, generation) => sum + (generation.estimatedCostUsd ?? 0), billed)
    : billed;
  if (own.some((generation) => generation.givenUpAt !== null)) {
    return { costStatus: 'unconfirmed', costUsd, costEstimated };
  }
  if (
    runStatus === 'running' ||
    own.some((generation) => generation.billedCostUsd === null)
  ) {
    return { costStatus: 'pending', costUsd, costEstimated };
  }
  return { costStatus: 'billed', costUsd, costEstimated };
};

const renderFigures = (
  scope: string,
  events: ScopedEvent[],
  shown: ScopedEvent[],
  report: ToolResultEvent | undefined,
  { generations, runStatus }: SubagentContext,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const event of events) {
    if (event.type === 'message') {
      inputTokens += event.usage.inputTokens;
      outputTokens += event.usage.outputTokens;
    }
  }
  return html`<span class="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-1 text-[0.8rem] tabular-nums text-muted" data-subagent-figures>
    ${renderStatus(subagentStatus(report, runStatus))}
    <span class="whitespace-nowrap" data-subagent-tokens>${renderTokens({ inputTokens, outputTokens })}</span>
    <span class="whitespace-nowrap" data-subagent-cost>${renderCost(subagentCost(scope, generations, runStatus))}</span>
    <span class="whitespace-nowrap">${messageCount(shown)}</span>
  </span>`;
};

const renderGroup = (
  frame: string,
  summary: Rendered,
  figures: Rendered,
  open: boolean,
  body: Rendered[],
): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<details class="${frame}" data-subagent-group${open ? html` open` : ''}>
    <summary class="${DISCLOSURE} flex-wrap">
      ${summary}
      ${figures}
    </summary>
    <div class="${STACK} rounded-b-[7px] border-t border-line bg-bg p-4 pt-3">
      ${body}
    </div>
  </details>`;

const renderSubagentCall = (
  call: ToolCallEvent,
  scope: string,
  events: ScopedEvent[],
  context: SubagentContext,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const report = context.results.get(call);
  const { results } = context;
  const failed = report?.isError === true;
  const task = taskText(call.arguments);
  const { cwd } = argumentFields(call.arguments);
  const shown = withoutToolOnlyPreambles(events);
  const reported = reportMessage(shown, report);
  return html`<section class="${BLOCK} ${failed ? 'border-error' : 'border-line'}" data-subagent-call${failed ? html` data-failed` : ''}>
    <header class="flex items-center gap-2.5 px-4 py-2.5">
      ${toolName(call.name, failed)}
      ${failed ? ERROR_BADGE : ''}
    </header>
    ${renderGroup(
      'border-t border-line',
      html`<span class="min-w-0 truncate text-[0.9rem]" data-subagent-task title="${oneLine(task)}">${oneLine(task)}</span>`,
      renderFigures(scope, events, shown, report, context),
      failed,
      [
        typeof cwd === 'string' ? renderText('cwd', cwd, PATH) : '',
        (typeof argumentFields(call.arguments).task === 'string' ? renderProse : renderText)('task', task),
        ...shown.filter((event) => event !== reported).map((event) => renderEvent(event, results)),
        report === undefined
          ? html`<p class="${EMPTY}">No report recorded.</p>`
          : failed ? renderText('error', report.text) : renderReport(report, reported),
      ],
    )}
  </section>`;
};

const renderSubagent = (
  { scope, call, events }: SubagentGroup,
  context: SubagentContext,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  if (call !== undefined) {
    return renderSubagentCall(call, scope, events, context);
  }
  const { results } = context;
  const shown = withoutToolOnlyPreambles(events);
  return renderGroup(
    `${BLOCK} border-line`,
    html`<span class="${LABEL} whitespace-nowrap">Subagent</span>
      <code class="${SUMMARY_CODE}" title="${scope}">${scope}</code>`,
    renderFigures(scope, events, shown, undefined, context),
    false,
    shown.map((event) => renderEvent(event, results)),
  );
};

const renderTranscript = (
  events: HarnessEvent[],
  generations: GenerationRecord[],
  runStatus: RunStatus,
): Rendered[] => {
  const results = toolResults(events);
  const context: SubagentContext = { results, generations, runStatus };
  const first = events[0];
  const prompt = first?.type === 'message' && first.role === 'user' ? first : undefined;
  return withoutToolOnlyPreambles(nestSubagents(events)).map((entry) =>
    entry.type === 'subagent'
      ? renderSubagent(entry, context)
      : entry === prompt
        ? renderMessage('prompt', entry)
        : renderEvent(entry, results),
  );
};

const NEW_ACTIVITY = 'fixed bottom-6 left-1/2 z-10 -translate-x-1/2 cursor-pointer rounded-full border border-line bg-surface px-4 py-1.5 text-sm font-semibold text-fg shadow-md hover:bg-raised';

const META_TERM = 'text-muted';
const META_VALUE = 'm-0 min-w-0 break-words tabular-nums';

export interface Downloads {
  transcript: boolean;
  rawEvents: boolean;
  requestRecord: boolean;
}

const DOWNLOADS: { key: keyof Downloads; path: string; label: string }[] = [
  { key: 'transcript', path: 'transcript', label: 'Transcript' },
  { key: 'rawEvents', path: 'raw-events', label: 'Raw events' },
  { key: 'requestRecord', path: 'request-record', label: 'Request record' },
];

const CONTEXT_BODY = 'rounded-b-[7px] border-t border-line bg-bg p-4 pt-3';

const renderSystemPrompt = (systemPrompt: string | null): Rendered =>
  systemPrompt === null
    ? ''
    : html`<details class="${BLOCK} border-line" data-system-prompt>
        <summary class="${DISCLOSURE}"><span class="${LABEL}">System prompt</span></summary>
        <div class="${CONTEXT_BODY}"><pre class="${PROSE} text-[0.9rem]">${systemPrompt}</pre></div>
      </details>`;

const renderToolDefinition = ({ name, description, parameters }: ToolDefinition): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<li class="${STACK} gap-1.5 border-t border-line pt-3 first:border-t-0 first:pt-0" data-tool>
    <code class="font-mono text-[0.85rem] font-semibold" data-tool-name>${name}</code>
    ${description === '' ? '' : html`<pre class="${PROSE} text-[0.9rem]">${description}</pre>`}
    ${parameters === null
      ? ''
      : html`<details>
          <summary class="${INLINE_DISCLOSURE} inline-flex font-semibold">Parameters</summary>
          <pre class="${CODE} mt-1.5">${JSON.stringify(parameters, null, 2)}</pre>
        </details>`}
  </li>`;

const renderTools = (tools: ToolDefinition[] | null): Rendered =>
  tools === null
    ? ''
    : html`<details class="${BLOCK} border-line" data-tools>
        <summary class="${DISCLOSURE}"><span class="${LABEL}">Tools</span><span class="text-xs tabular-nums text-muted" data-tool-count>${tools.length}</span></summary>
        <ul class="m-0 ${STACK} list-none ${CONTEXT_BODY}">${tools.map(renderToolDefinition)}</ul>
      </details>`;

const renderContext = ({ systemPrompt, tools }: WorkloadContext): Rendered =>
  systemPrompt === null && tools === null
    ? ''
    : html`<div class="${STACK} mb-4" data-context>${renderSystemPrompt(systemPrompt)}${renderTools(tools)}</div>`;

const renderDownloads = (run: RunRecord, downloads: Downloads): Rendered => {
  const offered = DOWNLOADS.filter(({ key }) => downloads[key]);
  if (offered.length === 0) return '';
  return html`<dt class="${META_TERM}">Downloads</dt>
      <dd class="${META_VALUE} flex flex-wrap gap-x-4 gap-y-1">${offered.map(
        ({ path, label }) =>
          html`<a href="/runs/${encodeURIComponent(run.id)}/${path}" download class="${LINK}" data-download="${path}">${label}</a>`,
      )}</dd>`;
};

export const renderDetail = (
  run: RunRecord,
  events: HarnessEvent[],
  { context, efforts: recordedEfforts }: RequestRecordView,
  generations: GenerationRecord[],
  downloads: Downloads,
  assets: AssetHrefs,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const live = !isSettled(run);
  const calls = generations.filter(isCall);
  const efforts = sentEfforts(calls, recordedEfforts);
  const body = html`<p class="m-0 mb-4 text-[0.9rem]"><a href="/" class="${LINK}">&larr; Workloads</a></p>
    <h1 class="${PAGE_TITLE} break-words">${run.worker}</h1>
    <dl class="m-0 mb-4 grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-6 gap-y-2 rounded-lg border border-line bg-surface px-4 py-3 text-[0.9rem]">
      <dt class="${META_TERM}">Model</dt>
      <dd class="${META_VALUE}">${run.model}</dd>
      <dt class="${META_TERM}">Reasoning effort</dt>
      <dd class="${META_VALUE}">${summaryEffort(run, efforts)}</dd>
      <dt class="${META_TERM}">Status</dt>
      <dd class="${META_VALUE}">${renderStatus(run.status)}</dd>
      <dt class="${META_TERM}">Started</dt>
      <dd class="${META_VALUE}">${renderTimestamp(run.startTime)}</dd>
      <dt class="${META_TERM}">Duration</dt>
      <dd class="${META_VALUE}">${formatDuration(run.startTime, run.endTime)}</dd>
      <dt class="${META_TERM}">Cost</dt>
      <dd class="${META_VALUE}">${renderCost(run)}</dd>
      <dt class="${META_TERM}">Tokens</dt>
      <dd class="${META_VALUE}">${renderTokens(run)}</dd>
      <dt class="${META_TERM}">Cache</dt>
      <dd class="${META_VALUE}">${renderCache(run)}</dd>
      <dt class="${META_TERM}">Cache hit rate</dt>
      <dd class="${META_VALUE}">${renderCacheHitRate(run)}</dd>
      <dt class="${META_TERM}">Providers</dt>
      <dd class="${META_VALUE}">${renderProviders(run, generations)}</dd>
      ${renderDownloads(run, downloads)}
    </dl>
    ${run.error === null ? '' : html`<p class="${run.status === 'interrupted' ? WARNING_CALLOUT : ERROR_CALLOUT} mb-4">${run.error}</p>`}
    ${renderContext(context)}
    ${renderCalls(calls, efforts)}
    <h2 class="${SECTION_TITLE} mt-8 mb-3">Transcript</h2>
    ${events.length === 0
      ? html`<p class="${EMPTY}">No transcript captured.</p>`
      : html`<div class="${STACK}" data-transcript="${events.length}">${renderTranscript(events, generations, run.status)}</div>`}
    ${live ? html`<button type="button" id="new-activity" hidden class="${NEW_ACTIVITY}">↓ New activity</button>` : ''}`;
  return layout(run.worker, null, live, assets, body);
};

const renderSpec = (parent: SpecRef | null): Rendered =>
  parent === null
    ? html`<span class="text-muted">No spec</span>`
    : html`<span class="tabular-nums">${isGithubUrl(parent.url)
        ? externalLink(parent.url, `#${parent.number}`)
        : html`#${parent.number}`}</span> ${parent.title}`;

const DISPATCH_TONE: Record<DispatchState, string> = {
  running: 'bg-raised text-fg',
  done: 'bg-success-soft text-success',
  failed: 'bg-error-soft text-error',
};

const FAILURE_LABEL: Record<DispatchFailure, string> = {
  errored: 'Run errored',
  'no-pull-request': 'No pull request',
  'skill-not-found': 'Skill not found',
  'devshell-failed': 'devShell failed',
  interrupted: 'Interrupted',
};

const failureText = ({ reason, detail }: DispatchRecord): string | null => {
  if (reason === null) return null;
  const label = FAILURE_LABEL[reason];
  return detail === null || detail.trim() === '' ? label : `${label}: ${detail}`;
};

const QUEUED_TONE = 'text-muted ring-1 ring-line ring-inset';

const renderDispatch = (ticket: Ticket, dispatch: DispatchRecord | undefined): Rendered => {
  if (ticket.forgeReady && ticket.blocked) {
    return html`<td class="${TD} min-w-48" data-dispatch="queued"><span class="${PILL} ${QUEUED_TONE}">queued</span></td>`;
  }
  if (dispatch === undefined) return html`<td class="${TD}"></td>`;
  const badge = html`<span class="${PILL} ${DISPATCH_TONE[dispatch.state]}">${dispatch.state}</span>`;
  const failure = failureText(dispatch);
  return html`<td class="${TD} min-w-48" data-dispatch="${dispatch.state}">${dispatch.runId === null
      ? badge
      : html`<a href="/runs/${encodeURIComponent(dispatch.runId)}" class="rounded-full no-underline hover:opacity-80">${badge}</a>`}${failure === null
      ? ''
      : html`<p class="m-0 mt-1 line-clamp-3 text-xs break-words whitespace-pre-line text-muted" title="${failure}">${failure}</p>`}</td>`;
};

const renderPolled = (polledAt: string | null): Rendered =>
  polledAt === null
    ? html`<span class="${POLLED}">Never polled</span>`
    : html`<span class="${POLLED}">Last polled ${renderTimestamp(polledAt)}</span>`;

const renderRepository = (
  { repository, github, polledAt, lastError, tickets }: RepositoryFrontier,
  dispatches: ReadonlyMap<string, DispatchRecord>,
): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<section class="mb-10" data-repository="${repository}"${lastError === null ? '' : html` data-stale`}>
    <header class="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <h2 class="${SECTION_TITLE}">${repository}</h2>
      ${isGithubRepository(github)
        ? externalLink(`https://github.com/${github}`, github)
        : html`<span class="text-muted">${github}</span>`}
      ${renderPolled(polledAt)}
    </header>
    ${lastError === null
      ? ''
      : html`<p class="${ERROR_CALLOUT} mb-3" data-poll-error>Last poll failed ${renderTimestamp(lastError.failedAt)}: ${lastError.message}</p>`}
    ${polledAt === null
      ? ''
      : tickets.length === 0
      ? html`<p class="${EMPTY}">No tickets on the frontier.</p>`
      : html`<div class="${CARD}">
          <table class="${TABLE}">
            <thead>
              <tr>
                <th class="${TH}">Ticket</th>
                <th class="${TH}">Title</th>
                <th class="${TH}">Spec</th>
                <th class="${TH}">Created</th>
                <th class="${TH}">Dispatch</th>
              </tr>
            </thead>
            <tbody${lastError === null ? '' : html` class="text-muted"`}>
              ${tickets.map(
                (ticket) => html`<tr class="${ROW}" data-ticket="${ticket.number}">
                  <td class="${TD} whitespace-nowrap tabular-nums">${isGithubUrl(ticket.url)
                    ? externalLink(ticket.url, `#${ticket.number}`)
                    : html`#${ticket.number}`}</td>
                  <td class="${TD} min-w-48">${ticket.title}</td>
                  <td class="${TD} min-w-48">${renderSpec(ticket.parent)}</td>
                  <td class="${TD}">${renderDate(ticket.createdAt)}</td>
                  ${renderDispatch(ticket, dispatches.get(ticketKey(repository, ticket.number)))}
                </tr>`,
              )}
            </tbody>
          </table>
        </div>`}
  </section>`;

export const renderWork = (
  frontier: RepositoryFrontier[],
  dispatches: DispatchRecord[],
  assets: AssetHrefs,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const byTicket = new Map(
    dispatches.map((dispatch) => [ticketKey(dispatch.repository, dispatch.number), dispatch]),
  );
  const body = html`<h1 class="${PAGE_TITLE}">Frontier</h1>
    ${frontier.length === 0
      ? html`<p class="${EMPTY}">No managed repositories have been polled yet.</p>`
      : frontier.map((repository) => renderRepository(repository, byTicket))}`;
  return layout('Frontier', 'work', true, assets, body);
};
