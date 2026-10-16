import { html } from 'hono/html';
import type { HarnessEvent, RunRecord } from '@forge/shared';
import type { HtmlEscapedString } from 'hono/utils/html';
import { formatTime } from '../format.ts';
import { BADGE, EMPTY, LINK, SECTION_TITLE, type Rendered } from './shared.ts';
import { widgetRows, type WidgetRow } from './transcript.ts';

const WIDGET_LIMIT = 50;

const PHONE_LIMIT = 5;

const ROW_LINK = 'flex items-baseline gap-3 px-4 py-1.5 text-[0.85rem] no-underline text-fg hover:bg-raised';

const transcriptPath = (run: RunRecord): string => `/runs/${encodeURIComponent(run.id)}/transcript`;

const renderRow = (run: RunRecord, timeZone: string, { anchor, kind, summary, timestamp, failed }: WidgetRow, index: number): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<li id="widget-event-${anchor}" data-widget-row class="border-t border-line first:border-t-0${index < PHONE_LIMIT ? '' : ' max-sm:hidden'}">
    <a href="${transcriptPath(run)}#event-${anchor}" class="${ROW_LINK}">
      <span class="w-[6.5rem] shrink-0 whitespace-nowrap tabular-nums text-muted max-sm:hidden">${timestamp === undefined ? '' : html`<time datetime="${timestamp}" title="${timestamp}">${formatTime(timestamp, timeZone)}</time>`}</span>
      <span class="w-[5.5rem] shrink-0 font-semibold text-muted max-sm:w-[4.5rem]" data-widget-kind>${kind}</span>
      <span class="min-w-0 flex-1 truncate" title="${summary}">${summary}</span>
      ${failed ? html`<span class="${BADGE} bg-error-soft text-error" data-badge="error">error</span>` : ''}
    </a>
  </li>`;

const renderBody = (run: RunRecord, listed: WidgetRow[], timeZone: string): Rendered => {
  if (listed.length === 0) return html`<p class="${EMPTY} px-4 py-3">No transcript captured.</p>`;
  const rows = listed.toReversed().slice(0, WIDGET_LIMIT);
  return html`<ol class="m-0 min-h-0 flex-1 list-none overflow-y-auto p-0" data-widget-rows>${rows.map((row, index) => renderRow(run, timeZone, row, index))}</ol>
    <p class="m-0 border-t border-line px-4 py-2.5 text-[0.9rem] sm:hidden"><a href="${transcriptPath(run)}" data-widget-open class="${LINK}">Open full transcript</a></p>`;
};

export const renderWidget = (run: RunRecord, events: HarnessEvent[], timeZone: string): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const listed = widgetRows(events);
  const failed = listed.some((row) => row.failed);
  return html`<section class="flex h-96 min-h-0 flex-col rounded-lg border border-line bg-surface max-sm:h-auto lg:h-full" data-widget>
    <header class="flex items-baseline gap-4 border-b border-line px-4 py-2.5">
      <h2 class="${SECTION_TITLE}">Transcript</h2>
      ${listed.length === 0 ? '' : html`<a href="${transcriptPath(run)}" data-widget-expand class="${LINK} text-[0.9rem] max-sm:hidden">Expand</a>`}
      ${failed ? html`<a href="${transcriptPath(run)}?show=errors" data-widget-first-error class="${LINK} text-[0.9rem]">First error</a>` : ''}
    </header>
    ${renderBody(run, listed, timeZone)}
  </section>`;
};
