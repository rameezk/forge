import { html, raw } from 'hono/html';
import { isGithubRepository, isGithubUrl } from '@forge/shared';
import type { HtmlEscapedString } from 'hono/utils/html';
import type {
  DispatchFailure,
  DispatchRecord,
  DispatchState,
  GenerationRecord,
  HarnessEvent,
  MessageEvent,
  RepositoryFrontier,
  RunRecord,
  RunStatus,
  RunTicket,
  SpecRef,
  ToolCallEvent,
  ToolResultEvent,
} from '@forge/shared';
import {
  formatCost,
  formatDate,
  formatDuration,
  formatStarted,
  formatTokens,
  formatTotal,
  pendingCount,
  settledCost,
} from './format.ts';
import { renderMarkdown } from './markdown.ts';

type Rendered = HtmlEscapedString | Promise<HtmlEscapedString> | '';

type Page = 'runs' | 'work';

const NAV: { page: Page; href: string; label: string }[] = [
  { page: 'runs', href: '/', label: 'Runs' },
  { page: 'work', href: '/work', label: 'Work' },
];

export interface AssetHrefs {
  stylesheet: string;
  logo: string;
}

const FOCUS_RINGS = '[&_:where(:focus-visible)]:outline-2 [&_:where(:focus-visible)]:outline-offset-2 [&_:where(:focus-visible)]:outline-accent';
const PAGE_TITLE = 'm-0 mb-3 text-xl font-bold';
const SECTION_TITLE = 'm-0 text-[1.1rem] font-bold';
const EMPTY = 'm-0 text-muted';
const LINK = 'rounded-sm font-medium text-accent-text no-underline hover:underline';
const ERROR_CALLOUT = 'm-0 rounded-lg bg-error-soft px-4 py-2.5 text-error break-words';
const CARD = 'overflow-x-auto rounded-lg border border-line bg-surface';
const TABLE = 'w-full border-collapse text-[0.9rem]';
const TH = 'whitespace-nowrap border-b border-line bg-raised px-3.5 py-2.5 text-left text-[0.7rem] font-semibold uppercase tracking-[0.06em] text-fg';
const TD = 'border-t border-line px-3.5 py-2.5 align-baseline';
const ROW = 'hover:bg-bg';
const NUMERIC = 'text-right tabular-nums whitespace-nowrap';
const PENDING = 'font-normal italic text-muted';
const NAV_LINK = 'border-b-2 py-1.5 text-[0.9rem] no-underline';
const POLLED = 'ml-auto text-sm text-muted';

const navLink = (href: string, label: string, current: boolean): HtmlEscapedString | Promise<HtmlEscapedString> =>
  current
    ? html`<a href="${href}" aria-current="page" class="${NAV_LINK} border-accent font-semibold text-fg">${label}</a>`
    : html`<a href="${href}" class="${NAV_LINK} border-transparent text-muted hover:text-fg">${label}</a>`;

const renderHeader = (
  current: Page | null,
  assets: AssetHrefs,
): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<header class="border-b border-line bg-surface">
    <div class="mx-auto flex max-w-6xl items-center gap-6 px-4 py-2">
      <a href="/" data-brand class="flex items-center gap-2 rounded-sm text-[1.05rem] font-bold tracking-tight text-fg no-underline"><img src="${assets.logo}" alt="" width="28" height="28" class="size-7" />Forge</a>
      <nav class="flex gap-4">
        ${NAV.map(({ page, href, label }) => navLink(href, label, page === current))}
      </nav>
    </div>
  </header>`;

const layout = (
  title: string,
  current: Page | null,
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
      </head>
      <body class="bg-bg text-[15px] text-fg ${FOCUS_RINGS}">
        ${renderHeader(current, assets)}
        <main class="mx-auto max-w-6xl px-4 py-8">${body}</main>
      </body>
    </html>`;

const BADGE = 'shrink-0 rounded px-1.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-[0.05em]';

const UNCONFIRMED_BADGE = html`<span class="${BADGE} ml-1.5 bg-warning-soft text-warning" data-badge="unconfirmed" title="forge could not confirm OpenRouter's billed cost for every generation, so this is only what was billed">unconfirmed</span>`;

const renderCost = (run: Pick<RunRecord, 'costStatus' | 'costUsd'>): Rendered => {
  switch (run.costStatus) {
    case 'pending':
      return html`<span class="${PENDING}">pending</span>`;
    case 'billed':
      return html`${formatCost(run.costUsd)}`;
    case 'unconfirmed':
      return html`${formatCost(run.costUsd)}${UNCONFIRMED_BADGE}`;
  }
};

const PILL = "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold before:size-1.5 before:rounded-full before:bg-current before:content-['']";

const STATUS_TONE: Record<RunStatus, string> = {
  success: 'bg-success-soft text-success',
  error: 'bg-error-soft text-error',
  running: 'bg-raised text-fg',
};

const renderStatus = (status: RunStatus): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<span class="${PILL} ${STATUS_TONE[status]}" data-status="${status}">${status}</span>`;

const renderTimestamp = (iso: string): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<time datetime="${iso}" title="${iso}" class="whitespace-nowrap">${formatStarted(iso)}</time>`;

const renderDate = (iso: string): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<time datetime="${iso}" title="${iso}" class="whitespace-nowrap">${formatDate(iso)}</time>`;

const renderRunTicket = (ticket: RunTicket | null): Rendered =>
  ticket === null
    ? ''
    : html`<span class="text-muted">${ticket.repository}</span> ${isGithubUrl(ticket.url)
        ? html`<a href="${ticket.url}" class="${LINK}">#${ticket.number}</a>`
        : html`#${ticket.number}`}`;

const renderTotal = (runs: RunRecord[]): Rendered => {
  const pending = pendingCount(runs);
  return html`${formatTotal(settledCost(runs))}${pending === 0
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
                  <th class="${TH}">Started</th>
                  <th class="${TH}">Duration</th>
                  <th class="${TH}">Status</th>
                  <th class="${TH} text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                ${runs.map(
                  (run) => html`<tr class="${ROW}" data-run="${run.id}">
                    <td class="${TD} whitespace-nowrap"><a href="/runs/${run.id}" class="${LINK}">${run.worker}</a></td>
                    <td class="${TD} whitespace-nowrap tabular-nums" data-run-ticket>${renderRunTicket(run.ticket)}</td>
                    <td class="${TD} whitespace-nowrap text-muted">${run.model}</td>
                    <td class="${TD}">${renderTimestamp(run.startTime)}</td>
                    <td class="${TD} whitespace-nowrap">${formatDuration(run.startTime, run.endTime)}</td>
                    <td class="${TD}">${renderStatus(run.status)}</td>
                    <td class="${TD} ${NUMERIC}" data-cost>${renderCost(run)}</td>
                  </tr>`,
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td colspan="6" class="${TD} font-semibold">Total</td>
                  <td class="${TD} ${NUMERIC} font-semibold">${renderTotal(runs)}</td>
                </tr>
              </tfoot>
            </table>
          </div>`;
  return layout('Workloads', 'runs', assets, body);
};

const BLOCK = 'rounded-lg border bg-surface';
const STACK = 'flex flex-col gap-3';
const LABEL = 'm-0 text-xs font-semibold uppercase tracking-[0.05em] text-muted';
const PROSE = 'm-0 whitespace-pre-wrap break-words font-sans';
const PATH = 'm-0 whitespace-pre-wrap break-words font-mono text-[0.85rem]';
const CODE = 'm-0 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-raised px-3 py-2.5 font-mono text-[0.8rem] leading-relaxed text-fg';

const MESSAGE_TONE = new Map([
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

const renderProse = (
  kind: string,
  text: string,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const tone = MESSAGE_TONE.get(kind) ?? DEFAULT_TONE;
  return html`<article class="${BLOCK} ${tone.border} px-4 py-3" data-message="${kind}">
    <header class="${LABEL} mb-1.5 ${tone.label}">${kind}</header>
    <div class="${MARKDOWN}" data-markdown>${raw(renderMarkdown(text))}</div>
  </article>`;
};

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

const renderEvent = (
  event: HarnessEvent,
  results: ToolResults,
): Rendered => {
  switch (event.type) {
    case 'message':
      return renderProse(event.role, event.text);
    case 'tool_call':
      return renderToolCall(event, results.get(event));
    case 'tool_result':
      return '';
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

type ScopedEvent = MessageEvent | ToolCallEvent | ToolResultEvent;

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

const withoutReportMessage = (
  events: ScopedEvent[],
  report: ToolResultEvent | undefined,
): ScopedEvent[] => {
  const last = events.findLastIndex(
    (event) => event.type === 'message' && event.role === 'assistant',
  );
  const message = events[last];
  return message?.type === 'message' && message.text === report?.text
    ? events.filter((_, index) => index !== last)
    : events;
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
  return runStatus === 'running' ? 'running' : 'error';
};

const subagentCost = (
  scope: string,
  generations: GenerationRecord[],
): Pick<RunRecord, 'costStatus' | 'costUsd'> => {
  const own = generations.filter((generation) => generation.subagent === scope);
  const costUsd = own.reduce(
    (sum, generation) => sum + (generation.billedCostUsd ?? 0),
    0,
  );
  if (own.some((generation) => generation.givenUpAt !== null)) {
    return { costStatus: 'unconfirmed', costUsd };
  }
  if (own.some((generation) => generation.billedCostUsd === null)) {
    return { costStatus: 'pending', costUsd };
  }
  return { costStatus: 'billed', costUsd };
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
    <span class="whitespace-nowrap" data-subagent-tokens>${formatTokens(inputTokens)} in / ${formatTokens(outputTokens)} out</span>
    <span class="whitespace-nowrap" data-subagent-cost>${renderCost(subagentCost(scope, generations))}</span>
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
        ...withoutReportMessage(shown, report).map((event) => renderEvent(event, results)),
        report === undefined
          ? html`<p class="${EMPTY}">No report recorded.</p>`
          : failed ? renderText('error', report.text) : renderProse('report', report.text),
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
  return withoutToolOnlyPreambles(nestSubagents(events)).map((entry) =>
    entry.type === 'subagent'
      ? renderSubagent(entry, context)
      : renderEvent(entry, results),
  );
};

const META_TERM = 'text-muted';
const META_VALUE = 'm-0 min-w-0 break-words tabular-nums';

export const renderDetail = (
  run: RunRecord,
  events: HarnessEvent[],
  generations: GenerationRecord[],
  assets: AssetHrefs,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const body = html`<p class="m-0 mb-4 text-[0.9rem]"><a href="/" class="${LINK}">&larr; Workloads</a></p>
    <h1 class="${PAGE_TITLE} break-words">${run.worker}</h1>
    <dl class="m-0 mb-4 grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-6 gap-y-2 rounded-lg border border-line bg-surface px-4 py-3 text-[0.9rem]">
      <dt class="${META_TERM}">Model</dt>
      <dd class="${META_VALUE}">${run.model}</dd>
      <dt class="${META_TERM}">Status</dt>
      <dd class="${META_VALUE}">${renderStatus(run.status)}</dd>
      <dt class="${META_TERM}">Started</dt>
      <dd class="${META_VALUE}">${renderTimestamp(run.startTime)}</dd>
      <dt class="${META_TERM}">Duration</dt>
      <dd class="${META_VALUE}">${formatDuration(run.startTime, run.endTime)}</dd>
      <dt class="${META_TERM}">Cost</dt>
      <dd class="${META_VALUE}">${renderCost(run)}</dd>
      <dt class="${META_TERM}">Tokens</dt>
      <dd class="${META_VALUE}">${formatTokens(run.inputTokens)} in / ${formatTokens(run.outputTokens)} out</dd>
    </dl>
    ${run.error === null ? '' : html`<p class="${ERROR_CALLOUT} mb-4">${run.error}</p>`}
    <h2 class="${SECTION_TITLE} mt-8 mb-3">Transcript</h2>
    ${events.length === 0
      ? html`<p class="${EMPTY}">No transcript captured.</p>`
      : html`<div class="${STACK}">${renderTranscript(events, generations, run.status)}</div>`}`;
  return layout(run.worker, null, assets, body);
};

const renderSpec = (parent: SpecRef | null): Rendered =>
  parent === null
    ? html`<span class="text-muted">No spec</span>`
    : html`<span class="tabular-nums text-muted">#${parent.number}</span> ${parent.title}`;

const DISPATCH_TONE: Record<DispatchState, string> = {
  running: 'bg-raised text-fg',
  done: 'bg-success-soft text-success',
  failed: 'bg-error-soft text-error',
};

const FAILURE_LABEL: Record<DispatchFailure, string> = {
  errored: 'Run errored',
  'no-pull-request': 'No pull request',
  'skill-not-found': 'Skill not found',
  interrupted: 'Interrupted',
};

const failureText = ({ reason, detail }: DispatchRecord): string | null => {
  if (reason === null) return null;
  const label = FAILURE_LABEL[reason];
  return detail === null || detail.trim() === '' ? label : `${label}: ${detail}`;
};

const renderDispatch = (dispatch: DispatchRecord | undefined): Rendered => {
  if (dispatch === undefined) return html`<td class="${TD}"></td>`;
  const badge = html`<span class="${PILL} ${DISPATCH_TONE[dispatch.state]}">${dispatch.state}</span>`;
  const failure = failureText(dispatch);
  return html`<td class="${TD} min-w-48" data-dispatch="${dispatch.state}">${dispatch.runId === null
      ? badge
      : html`<a href="/runs/${encodeURIComponent(dispatch.runId)}" class="rounded-full no-underline hover:opacity-80">${badge}</a>`}${failure === null
      ? ''
      : html`<p class="m-0 mt-1 line-clamp-3 text-xs break-words whitespace-pre-line text-muted" title="${failure}">${failure}</p>`}</td>`;
};

const ticketKey = (repository: string, number: number): string =>
  `${repository}#${number}`;

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
        ? html`<a href="https://github.com/${github}" class="${LINK}">${github}</a>`
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
                    ? html`<a href="${ticket.url}" class="${LINK}">#${ticket.number}</a>`
                    : html`#${ticket.number}`}</td>
                  <td class="${TD} min-w-48">${ticket.title}</td>
                  <td class="${TD} min-w-48">${renderSpec(ticket.parent)}</td>
                  <td class="${TD}">${renderDate(ticket.createdAt)}</td>
                  ${renderDispatch(dispatches.get(ticketKey(repository, ticket.number)))}
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
  return layout('Frontier', 'work', assets, body);
};
