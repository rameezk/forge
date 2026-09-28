import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import type {
  HarnessEvent,
  MessageEvent,
  RunRecord,
  ToolCallEvent,
  ToolResultEvent,
} from '@forge/shared';
import { SUBAGENT_TOOL } from '@forge/pi-subagent';
import { formatCost, formatDuration, totalCost } from './format.ts';

const STYLES = `
  :root { color-scheme: light dark; --line: color-mix(in srgb, currentColor 15%, transparent); }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 960px; margin: 0 auto; padding: 2rem 1rem; }
  h1 { font-size: 1.4rem; margin: 0 0 1.5rem; }
  a { color: inherit; }
  .table-scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.6rem 0.75rem; border-bottom: 1px solid var(--line); }
  th { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.65; }
  td.cost, th.cost { text-align: right; font-variant-numeric: tabular-nums; }
  tfoot td { font-weight: 600; border-bottom: none; }
  .status { font-size: 0.8rem; padding: 0.1rem 0.5rem; border-radius: 999px; border: 1px solid var(--line); }
  .status-success { color: #1a7f37; }
  .status-error { color: #cf222e; }
  .status-running { opacity: 0.7; }
  tr.cost-uncertain td.cost { color: #9a6700; }
  .badge { margin-left: 0.4rem; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; color: #9a6700; border: 1px solid currentColor; border-radius: 999px; padding: 0.05rem 0.4rem; }
  .empty { opacity: 0.6; }
  .meta { display: grid; grid-template-columns: max-content 1fr; gap: 0.3rem 1rem; margin: 0 0 1.5rem; }
  .meta dt { opacity: 0.6; }
  .meta dd { margin: 0; font-variant-numeric: tabular-nums; }
  .message, .subagent, .tool { border: 1px solid var(--line); border-radius: 8px; margin: 0 0 0.75rem; }
  .message { padding: 0.75rem 1rem; }
  .message > header { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.65; margin-bottom: 0.4rem; }
  .message pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: inherit; }
  .message-result { opacity: 0.75; font-style: italic; }
  .subagent > summary, .tool > summary { display: flex; align-items: center; gap: 0.6rem; padding: 0.6rem 1rem; cursor: pointer; list-style: none; }
  .subagent > summary::-webkit-details-marker, .tool > summary::-webkit-details-marker { display: none; }
  .subagent > summary::before, .tool > summary::before { content: '\\25B6'; display: inline-block; width: 1em; font-size: 0.7rem; text-align: center; opacity: 0.65; transition: transform 0.15s; }
  .subagent[open] > summary::before, .tool[open] > summary::before { transform: rotate(90deg); }
  .subagent-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.65; white-space: nowrap; }
  .tool-name { font: 600 0.85rem ui-monospace, monospace; white-space: nowrap; }
  .tool > summary code { opacity: 0.75; }
  summary code, .subagent-task { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.85rem; }
  .subagent-count { margin-left: auto; white-space: nowrap; font-size: 0.8rem; opacity: 0.6; font-variant-numeric: tabular-nums; }
  .subagent-body { padding: 0.75rem 1rem 0; border-top: 1px solid var(--line); }
  .message-report { border-color: color-mix(in srgb, currentColor 35%, transparent); }
  .tool-error { border-color: #cf222e; }
  .tool-error .tool-name { color: #cf222e; }
  .badge.tool-status { margin-left: auto; flex-shrink: 0; color: #cf222e; }
  .subagent-call > header { display: flex; align-items: center; gap: 0.6rem; padding: 0.6rem 1rem; }
  .subagent-call > .subagent { border: none; border-top: 1px solid var(--line); border-radius: 0; margin: 0; }
  .message-error { border-color: #cf222e; }
  .message-error > header { color: #cf222e; opacity: 1; }
  .tool-body { padding: 0.6rem 1rem 0.75rem; border-top: 1px solid var(--line); }
  .tool-body > header { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.65; margin: 0 0 0.3rem; }
  .tool-body > header ~ header { margin-top: 0.75rem; }
  .tool-body pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 0.85rem; }
`;

const layout = (
  title: string,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <style>
          ${raw(STYLES)}
        </style>
      </head>
      <body>
        <main>${body}</main>
      </body>
    </html>`;

export const renderList = (
  runs: RunRecord[],
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const body =
    runs.length === 0
      ? html`<h1>Workloads</h1>
          <p class="empty">No workloads have run yet.</p>`
      : html`<h1>Workloads</h1>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Worker</th>
                  <th>Model</th>
                  <th>Started</th>
                  <th>Duration</th>
                  <th>Status</th>
                  <th class="cost">Cost</th>
                </tr>
              </thead>
              <tbody>
                ${runs.map(
                  (run) => html`<tr class="run ${run.costUncertain ? 'cost-uncertain' : ''}">
                    <td><a href="/runs/${run.id}">${run.worker}</a></td>
                    <td>${run.model}</td>
                    <td>${run.startTime}</td>
                    <td>${formatDuration(run.startTime, run.endTime)}</td>
                    <td><span class="status status-${run.status}">${run.status}</span></td>
                    <td class="cost">
                      ${formatCost(run.costUsd)}${run.costUncertain
                        ? html`<span class="badge" title="OpenRouter's billed cost could not be confirmed for every generation">uncertain</span>`
                        : ''}
                    </td>
                  </tr>`,
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td colspan="5">Total</td>
                  <td class="cost">${formatCost(totalCost(runs))}</td>
                </tr>
              </tfoot>
            </table>
          </div>`;
  return layout('Workloads', body);
};

const renderText = (
  kind: string,
  text: string,
): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<article class="message message-${kind}">
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

const argumentSummary = (args: unknown): string => {
  const summary = summaryText(args);
  return typeof summary === 'string' ? summary.replace(/\s+/g, ' ').trim() : '';
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

const renderToolCall = (
  call: ToolCallEvent,
  result: ToolResultEvent | undefined,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const summary = argumentSummary(call.arguments);
  const failed = result?.isError === true;
  return html`<details class="tool${failed ? ' tool-error' : ''}"${failed ? html` open` : ''}>
    <summary>
      <span class="tool-name">${call.name}</span>
      <code title="${summary}">${summary}</code>
      ${failed ? html`<span class="badge tool-status">error</span>` : ''}
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
): HtmlEscapedString | Promise<HtmlEscapedString> | '' => {
  switch (event.type) {
    case 'message':
      return renderText(event.role, event.text);
    case 'tool_call':
      return renderToolCall(event, results.get(event));
    case 'tool_result':
      return '';
    case 'result':
      return html`<article class="message message-result">
        Run ${event.status}${event.error === null ? '' : html`: ${event.error}`}
      </article>`;
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

const isSubagentCall = (event: HarnessEvent): event is ToolCallEvent =>
  event.type === 'tool_call' &&
  event.name === SUBAGENT_TOOL &&
  event.subagent === undefined;

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
  const groups = new Map<string, SubagentGroup>();
  const entries: TranscriptEntry[] = [];
  for (const event of events) {
    if (isSubagentCall(event)) {
      const group: SubagentGroup = { type: 'subagent', scope: event.id, call: event, events: [] };
      groups.set(event.id, group);
      entries.push(group);
    } else if (event.type === 'result' || event.subagent === undefined) {
      entries.push(event);
    } else {
      const group = groups.get(event.subagent);
      if (group === undefined) {
        const orphan: SubagentGroup = { type: 'subagent', scope: event.subagent, events: [event] };
        groups.set(event.subagent, orphan);
        entries.push(orphan);
      } else {
        group.events.push(event);
      }
    }
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

const taskText = (args: unknown): string => {
  const task = typeof args === 'object' && args !== null
    ? (args as Record<string, unknown>).task
    : undefined;
  return typeof task === 'string' ? task : prettyArguments(args);
};

const renderSubagentCall = (
  call: ToolCallEvent,
  events: ScopedEvent[],
  results: ToolResults,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const report = results.get(call);
  const failed = report?.isError === true;
  const task = argumentSummary(call.arguments);
  const shown = withoutToolOnlyPreambles(events);
  return html`<section class="tool subagent-call${failed ? ' tool-error' : ''}">
    <header>
      <span class="tool-name">${call.name}</span>
      ${failed ? html`<span class="badge tool-status">error</span>` : ''}
    </header>
    <details class="subagent"${failed ? html` open` : ''}>
      <summary>
        <span class="subagent-task" title="${task}">${task}</span>
        <span class="subagent-count">${messageCount(shown)}</span>
      </summary>
      <div class="subagent-body">
        ${renderText('task', taskText(call.arguments))}
        ${withoutReportMessage(shown, report).map(
          (event) => renderEvent(event, results),
        )}
        ${report === undefined
          ? html`<p class="empty">No report recorded.</p>`
          : renderText(failed ? 'error' : 'report', report.text)}
      </div>
    </details>
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
  return html`<details class="subagent">
    <summary>
      <span class="subagent-label">Subagent</span>
      <code title="${scope}">${scope}</code>
      <span class="subagent-count">${messageCount(shown)}</span>
    </summary>
    <div class="subagent-body">
      ${shown.map((event) => renderEvent(event, results))}
    </div>
  </details>`;
};

const renderTranscript = (
  events: HarnessEvent[],
): (HtmlEscapedString | Promise<HtmlEscapedString> | '')[] => {
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
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const body = html`<p><a href="/">&larr; Workloads</a></p>
    <h1>${run.worker}</h1>
    <dl class="meta">
      <dt>Model</dt>
      <dd>${run.model}</dd>
      <dt>Status</dt>
      <dd>${run.status}</dd>
      <dt>Started</dt>
      <dd>${run.startTime}</dd>
      <dt>Duration</dt>
      <dd>${formatDuration(run.startTime, run.endTime)}</dd>
      <dt>Cost</dt>
      <dd>
        ${formatCost(run.costUsd)}${run.costUncertain ? ' (uncertain)' : ''}
      </dd>
      <dt>Tokens</dt>
      <dd>${run.inputTokens} in / ${run.outputTokens} out</dd>
    </dl>
    ${run.error === null ? '' : html`<p class="status-error">${run.error}</p>`}
    <h2>Transcript</h2>
    ${events.length === 0
      ? html`<p class="empty">No transcript captured.</p>`
      : renderTranscript(events)}`;
  return layout(run.worker, body);
};
