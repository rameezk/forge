import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import type { HarnessEvent, RunRecord } from '@forge/shared';
import { formatCost, formatDuration, totalCost } from './format.ts';

const STYLES = `
  :root { color-scheme: light dark; --line: color-mix(in srgb, currentColor 15%, transparent); }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 960px; margin: 0 auto; padding: 2rem 1rem; }
  h1 { font-size: 1.4rem; margin: 0 0 1.5rem; }
  a { color: inherit; }
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
  .message { border: 1px solid var(--line); border-radius: 8px; padding: 0.75rem 1rem; margin: 0 0 0.75rem; }
  .message > header { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.65; margin-bottom: 0.4rem; }
  .message pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: inherit; }
  .message-result { opacity: 0.75; font-style: italic; }
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
                      ? html`<span class="badge" title="model reported zero cost despite output tokens">uncertain</span>`
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
          </table>`;
  return layout('Workloads', body);
};

const renderMessage = (
  event: HarnessEvent,
): HtmlEscapedString | Promise<HtmlEscapedString> =>
  event.type === 'message'
    ? html`<article class="message message-${event.role}">
        <header>${event.role}</header>
        <pre>${event.text}</pre>
      </article>`
    : html`<article class="message message-result">
        Run ${event.status}${event.error === null ? '' : html`: ${event.error}`}
      </article>`;

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
      : events.map(renderMessage)}`;
  return layout(run.worker, body);
};
