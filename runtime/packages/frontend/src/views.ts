import { html } from 'hono/html';
import { isGithubRepository, isGithubUrl } from '@forge/shared';
import type { HtmlEscapedString } from 'hono/utils/html';
import type {
  HarnessEvent,
  MessageEvent,
  RepositoryFrontier,
  RunRecord,
  RunStatus,
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

const PAGE_TITLE = 'm-0 mb-3 text-xl font-bold';
const EMPTY = 'm-0 text-muted';
const LINK = 'font-medium text-accent-text no-underline hover:underline';
const CARD = 'overflow-x-auto rounded-lg border border-line bg-surface';
const TABLE = 'w-full border-collapse text-[0.9rem]';
const TH = 'whitespace-nowrap border-b border-line bg-raised px-3.5 py-2.5 text-left text-[0.7rem] font-semibold uppercase tracking-[0.06em] text-fg';
const TD = 'border-t border-line px-3.5 py-2.5 align-baseline';
const ROW = 'hover:bg-bg';
const NUMERIC = 'text-right tabular-nums whitespace-nowrap';
const PENDING = 'font-normal italic text-muted';

const navLink = (href: string, label: string, current: boolean): HtmlEscapedString | Promise<HtmlEscapedString> =>
  current
    ? html`<a href="${href}" aria-current="page" class="border-b-2 border-accent py-1.5 text-[0.9rem] font-semibold text-fg no-underline">${label}</a>`
    : html`<a href="${href}" class="border-b-2 border-transparent py-1.5 text-[0.9rem] text-muted no-underline hover:text-fg">${label}</a>`;

const renderHeader = (
  current: Page | null,
  assets: AssetHrefs,
): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<header class="border-b border-line bg-surface">
    <div class="mx-auto flex max-w-6xl items-center gap-6 px-4 py-2">
      <a href="/" data-brand class="flex items-center gap-2 text-[1.05rem] font-bold tracking-tight text-fg no-underline"><img src="${assets.logo}" alt="" width="28" height="28" class="size-7" />Forge</a>
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
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <link rel="icon" type="image/svg+xml" href="${assets.logo}" />
        <link rel="stylesheet" href="${assets.stylesheet}" />
      </head>
      <body class="bg-bg text-fg">
        ${renderHeader(current, assets)}
        <main class="mx-auto max-w-6xl px-4 py-8">${body}</main>
      </body>
    </html>`;

const UNCONFIRMED_BADGE = html`<span class="ml-1.5 rounded bg-warning-soft px-1.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-[0.05em] text-warning" data-badge="unconfirmed" title="forge could not confirm OpenRouter's billed cost for every generation, so this is only what was billed">unconfirmed</span>`;

const renderCost = (run: RunRecord): Rendered => {
  switch (run.costStatus) {
    case 'pending':
      return html`<span class="${PENDING}">pending</span>`;
    case 'billed':
      return html`${formatCost(run.costUsd)}`;
    case 'unconfirmed':
      return html`${formatCost(run.costUsd)}${UNCONFIRMED_BADGE}`;
  }
};

const STATUS_TONE: Record<RunStatus, string> = {
  success: 'bg-success-soft text-success',
  error: 'bg-error-soft text-error',
  running: 'bg-raised text-fg',
};

const renderStatus = (status: RunStatus): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<span class="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold before:size-1.5 before:rounded-full before:bg-current before:content-[''] ${STATUS_TONE[status]}" data-status="${status}">${status}</span>`;

const renderTimestamp = (iso: string): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<time datetime="${iso}" title="${iso}">${formatStarted(iso)}</time>`;

const renderDate = (iso: string): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<time datetime="${iso}" title="${iso}">${formatDate(iso)}</time>`;

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
                  <td colspan="5" class="${TD} font-semibold">Total</td>
                  <td class="${TD} ${NUMERIC} font-semibold">${renderTotal(runs)}</td>
                </tr>
              </tfoot>
            </table>
          </div>`;
  return layout('Workloads', 'runs', assets, body);
};

const renderText = (
  kind: string,
  text: string,
): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<article class="message message-${kind}" data-message="${kind}">
    <header>${kind}</header>
    <pre>${text}</pre>
  </article>`;

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

const toolName = (name: string): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<span class="tool-name" data-tool-name>${name}</span>`;

const ERROR_BADGE = html`<span class="badge tool-status" data-badge="error">error</span>`;

const renderToolCall = (
  call: ToolCallEvent,
  result: ToolResultEvent | undefined,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const summary = argumentSummary(call.arguments);
  const failed = result?.isError === true;
  return html`<details class="tool${failed ? ' tool-error' : ''}" data-tool-call${failed ? html` data-failed open` : ''}>
    <summary>
      ${toolName(call.name)}
      <code title="${summary}">${summary}</code>
      ${failed ? ERROR_BADGE : ''}
    </summary>
    <div class="tool-body">
      <header>Arguments</header>
      <pre>${prettyArguments(call.arguments)}</pre>
      <header>Result</header>
      ${result === undefined
        ? html`<p class="empty">No result recorded.</p>`
        : html`<pre>${result.text}</pre>`}
    </div>
  </details>`;
};

const renderEvent = (
  event: HarnessEvent,
  results: ToolResults,
): Rendered => {
  switch (event.type) {
    case 'message':
      return renderText(event.role, event.text);
    case 'tool_call':
      return renderToolCall(event, results.get(event));
    case 'tool_result':
      return '';
    case 'result':
      return html`<article class="message message-result" data-message="result">${renderStatus(event.status)}${event.error === null
        ? ''
        : html`<span>${event.error}</span>`}</article>`;
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

const renderGroup = (
  summary: Rendered,
  count: string,
  open: boolean,
  body: Rendered[],
): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<details class="subagent" data-subagent-group${open ? html` open` : ''}>
    <summary>
      ${summary}
      <span class="subagent-count">${count}</span>
    </summary>
    <div class="subagent-body">
      ${body}
    </div>
  </details>`;

const renderSubagentCall = (
  call: ToolCallEvent,
  events: ScopedEvent[],
  results: ToolResults,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const report = results.get(call);
  const failed = report?.isError === true;
  const task = taskText(call.arguments);
  const { cwd } = argumentFields(call.arguments);
  const shown = withoutToolOnlyPreambles(events);
  return html`<section class="tool subagent-call${failed ? ' tool-error' : ''}" data-subagent-call${failed ? html` data-failed` : ''}>
    <header>
      ${toolName(call.name)}
      ${failed ? ERROR_BADGE : ''}
    </header>
    ${renderGroup(
      html`<span class="subagent-task" data-subagent-task title="${oneLine(task)}">${oneLine(task)}</span>`,
      messageCount(shown),
      failed,
      [
        typeof cwd === 'string' ? renderText('cwd', cwd) : '',
        renderText('task', task),
        ...withoutReportMessage(shown, report).map((event) => renderEvent(event, results)),
        report === undefined
          ? html`<p class="empty">No report recorded.</p>`
          : renderText(failed ? 'error' : 'report', report.text),
      ],
    )}
  </section>`;
};

const renderSubagent = (
  { scope, call, events }: SubagentGroup,
  results: ToolResults,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  if (call !== undefined) {
    return renderSubagentCall(call, events, results);
  }
  const shown = withoutToolOnlyPreambles(events);
  return renderGroup(
    html`<span class="subagent-label">Subagent</span>
      <code title="${scope}">${scope}</code>`,
    messageCount(shown),
    false,
    shown.map((event) => renderEvent(event, results)),
  );
};

const renderTranscript = (
  events: HarnessEvent[],
): Rendered[] => {
  const results = toolResults(events);
  return withoutToolOnlyPreambles(nestSubagents(events)).map((entry) =>
    entry.type === 'subagent'
      ? renderSubagent(entry, results)
      : renderEvent(entry, results),
  );
};

export const renderDetail = (
  run: RunRecord,
  events: HarnessEvent[],
  assets: AssetHrefs,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const body = html`<p><a href="/">&larr; Workloads</a></p>
    <h1>${run.worker}</h1>
    <dl class="meta">
      <dt>Model</dt>
      <dd>${run.model}</dd>
      <dt>Status</dt>
      <dd>${renderStatus(run.status)}</dd>
      <dt>Started</dt>
      <dd>${renderTimestamp(run.startTime)}</dd>
      <dt>Duration</dt>
      <dd>${formatDuration(run.startTime, run.endTime)}</dd>
      <dt>Cost</dt>
      <dd>${renderCost(run)}</dd>
      <dt>Tokens</dt>
      <dd>${formatTokens(run.inputTokens)} in / ${formatTokens(run.outputTokens)} out</dd>
    </dl>
    ${run.error === null ? '' : html`<p class="status-error">${run.error}</p>`}
    <h2>Transcript</h2>
    ${events.length === 0
      ? html`<p class="empty">No transcript captured.</p>`
      : renderTranscript(events)}`;
  return layout(run.worker, null, assets, body);
};

const renderSpec = (parent: SpecRef | null): Rendered =>
  parent === null
    ? html`<span class="text-muted">No spec</span>`
    : html`<span class="tabular-nums text-muted">#${parent.number}</span> ${parent.title}`;

const renderPolled = (polledAt: string | null): Rendered =>
  polledAt === null
    ? html`<span class="ml-auto text-sm text-muted">Never polled</span>`
    : html`<span class="ml-auto text-sm text-muted">Last polled ${renderTimestamp(polledAt)}</span>`;

const renderRepository = ({
  repository,
  github,
  polledAt,
  lastError,
  tickets,
}: RepositoryFrontier): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<section class="mb-10" data-repository="${repository}"${lastError === null ? '' : html` data-stale`}>
    <header class="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <h2 class="m-0 text-[1.1rem] font-bold">${repository}</h2>
      ${isGithubRepository(github)
        ? html`<a href="https://github.com/${github}" class="${LINK}">${github}</a>`
        : html`<span class="text-muted">${github}</span>`}
      ${renderPolled(polledAt)}
    </header>
    ${lastError === null
      ? ''
      : html`<p class="m-0 mb-3 rounded-lg bg-error-soft px-4 py-2.5 text-error break-words" data-poll-error>Last poll failed ${renderTimestamp(lastError.failedAt)}: ${lastError.message}</p>`}
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
                </tr>`,
              )}
            </tbody>
          </table>
        </div>`}
  </section>`;

export const renderWork = (
  frontier: RepositoryFrontier[],
  assets: AssetHrefs,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const body = html`<h1 class="${PAGE_TITLE}">Frontier</h1>
    ${frontier.length === 0
      ? html`<p class="${EMPTY}">No managed repositories have been polled yet.</p>`
      : frontier.map(renderRepository)}`;
  return layout('Frontier', 'work', assets, body);
};
