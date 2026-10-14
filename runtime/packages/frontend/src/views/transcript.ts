import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import type { GenerationRecord, HarnessEvent, CompactionEvent, MessageEvent, ResultEvent, RetryEvent, RunSkillLoad, RunStatus, ToolCallEvent, ToolResultEvent } from '@forge/shared';
import { formatTime, formatTokens } from '../format.ts';
import { renderMarkdown } from '../markdown.ts';
import { PROSE, BLOCK, LABEL, type Rendered, INLINE_DISCLOSURE, ERROR_CALLOUT, BADGE, DISCLOSURE, CODE, EMPTY, renderStatus, type Cost, renderTokens, renderCost, STACK } from './shared.ts';

const PATH = 'm-0 whitespace-pre-wrap break-words font-mono text-[0.85rem]';

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
    case 'cache_warm':
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

const givenTask = (args: unknown): string | undefined => {
  const { task, prompt } = argumentFields(args);
  return [task, prompt].find((text): text is string => typeof text === 'string');
};

const taskText = (args: unknown): string => givenTask(args) ?? prettyArguments(args);

interface SubagentContext {
  results: ToolResults;
  generations: GenerationRecord[];
  runStatus: RunStatus;
  subscription: boolean;
  kinds: ReadonlyMap<string, string[]>;
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
  subscription: boolean,
): Cost => {
  if (subscription) return { costStatus: 'subscription', costUsd: 0, costEstimated: false };
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

const KIND_CHIP = 'whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[0.75rem]';

const renderKinds = (kinds: string[] | undefined): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<span class="flex flex-wrap items-center gap-1.5" data-subagent-kinds>${kinds === undefined
    ? html`<span class="${KIND_CHIP} border-dashed border-line italic" data-subagent-kind>unclassified</span>`
    : kinds.map((kind) => html`<span class="${KIND_CHIP} border-line bg-raised text-fg" data-subagent-kind>${kind}</span>`)}</span>`;

const renderFigures = (
  scope: string,
  events: ScopedEvent[],
  shown: ScopedEvent[],
  report: ToolResultEvent | undefined,
  { generations, runStatus, subscription, kinds }: SubagentContext,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const event of events) {
    if (event.type === 'message') {
      inputTokens += event.usage.inputTokens;
      outputTokens += event.usage.outputTokens;
    }
  }
  return html`<span class="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-1 text-[0.8rem] tabular-nums text-muted" data-subagent-figures>
    ${renderKinds(kinds.get(scope))}
    ${renderStatus(subagentStatus(report, runStatus))}
    <span class="whitespace-nowrap" data-subagent-tokens>${renderTokens({ inputTokens, outputTokens })}</span>
    <span class="whitespace-nowrap" data-subagent-cost>${renderCost(subagentCost(scope, generations, runStatus, subscription))}</span>
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
      html`<span class="min-w-0 flex-1 basis-40 truncate text-[0.9rem]" data-subagent-task title="${oneLine(task)}">${oneLine(task)}</span>`,
      renderFigures(scope, events, shown, report, context),
      failed,
      [
        typeof cwd === 'string' ? renderText('cwd', cwd, PATH) : '',
        (givenTask(call.arguments) === undefined ? renderText : renderProse)('task', task),
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

const subagentKinds = (loads: RunSkillLoad[]): Map<string, string[]> => {
  const kinds = new Map<string, string[]>();
  for (const { skill, subagent } of loads) {
    if (subagent !== null) {
      kinds.set(subagent, [...(kinds.get(subagent) ?? []), skill].sort((a, b) => a.localeCompare(b)));
    }
  }
  return kinds;
};

const withoutErrorReportedByResult = (events: HarnessEvent[]): HarnessEvent[] => {
  const result = events.find((event): event is ResultEvent => event.type === 'result');
  if (result === undefined || result.error === null) return events;
  const failed = events.findLastIndex(
    (event) => event.type === 'message' && event.role === 'assistant' && event.subagent === undefined,
  );
  const last = events[failed];
  if (last?.type !== 'message' || last.error !== result.error) return events;
  const { error: _reported, ...unreported } = last;
  if (last.text === '' && last.thinking === undefined) return events.filter((event) => event !== last);
  return events.map((event) => (event === last ? unreported : event));
};

export const renderTranscript = (
  events: HarnessEvent[],
  generations: GenerationRecord[],
  runStatus: RunStatus,
  subscription: boolean,
  skillLoads: RunSkillLoad[],
): Rendered[] => {
  const results = toolResults(events);
  const context: SubagentContext = { results, generations, runStatus, subscription, kinds: subagentKinds(skillLoads) };
  const first = events[0];
  const prompt = first?.type === 'message' && first.role === 'user' ? first : undefined;
  return withoutToolOnlyPreambles(nestSubagents(withoutErrorReportedByResult(events))).map((entry) =>
    entry.type === 'subagent'
      ? renderSubagent(entry, context)
      : entry === prompt
        ? renderMessage('prompt', entry)
        : renderEvent(entry, results),
  );
};
