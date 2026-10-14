import { html } from 'hono/html';
import type { GenerationRecord, HarnessEvent, RunRecord, RunSkillLoad } from '@forge/shared';
import type { HtmlEscapedString } from 'hono/utils/html';
import { isSettled } from './run.ts';
import { EMPTY, LINK, PAGE_TITLE, STACK, layout, renderStatus, type AssetHrefs, type Rendered } from './shared.ts';
import { transcriptItems, type TranscriptFilter } from './transcript.ts';

export type TranscriptShow = 'all' | TranscriptFilter;

const FILTERS: { show: TranscriptShow; label: string }[] = [
  { show: 'all', label: 'All' },
  { show: 'messages', label: 'Messages' },
  { show: 'tools', label: 'Tool calls' },
  { show: 'errors', label: 'Errors' },
  { show: 'subagents', label: 'Subagents' },
];

export const parseTranscriptShow = (value: string | undefined): TranscriptShow =>
  FILTERS.find(({ show }) => show === value)?.show ?? 'all';

const CHIP = 'flex shrink-0 items-baseline justify-between gap-3 rounded-md border px-3 py-1.5 text-[0.9rem] no-underline';

const NEW_ACTIVITY = 'fixed bottom-6 left-1/2 z-10 -translate-x-1/2 cursor-pointer rounded-full border border-line bg-surface px-4 py-1.5 text-sm font-semibold text-fg shadow-md hover:bg-raised';

const hrefOf = (run: RunRecord, show: TranscriptShow): string =>
  `/runs/${encodeURIComponent(run.id)}/transcript${show === 'all' ? '' : `?show=${show}`}`;

const renderFilter = (
  run: RunRecord,
  { show, label }: { show: TranscriptShow; label: string },
  selected: TranscriptShow,
  count: number,
): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<a href="${hrefOf(run, show)}" data-filter="${show}"${show === selected ? html` aria-current="page"` : ''} class="${CHIP} ${show === selected ? 'border-accent bg-raised font-semibold text-fg' : 'border-line text-muted hover:text-fg'}">${label}<span class="tabular-nums" data-count>${count}</span></a>`;

export const renderFullTranscript = (
  run: RunRecord,
  events: HarnessEvent[],
  generations: GenerationRecord[],
  skillLoads: RunSkillLoad[],
  show: TranscriptShow,
  assets: AssetHrefs,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const live = !isSettled(run);
  const items = transcriptItems(events, generations, run.status, run.costStatus === 'subscription', skillLoads);
  const shown = show === 'all' ? items : items.filter(({ kinds }) => kinds.includes(show));
  const count = (filter: TranscriptShow): number =>
    filter === 'all' ? items.length : items.filter(({ kinds }) => kinds.includes(filter)).length;
  const listed: Rendered =
    shown.length === 0
      ? html`<p class="${EMPTY}" data-empty>${events.length === 0 ? 'No transcript captured.' : 'No events match this filter.'}</p>`
      : html`<div class="${STACK}" data-transcript="${events.length}">${shown.map(({ rendered }) => rendered)}</div>`;
  const body = html`<p class="m-0 mb-4 text-[0.9rem]"><a href="/runs/${encodeURIComponent(run.id)}" data-back-to-run class="${LINK}">&larr; ${run.worker}</a></p>
    <h1 class="${PAGE_TITLE} flex flex-wrap items-baseline gap-3 break-words">Transcript ${renderStatus(run.status)}</h1>
    <div class="flex flex-col gap-4 md:flex-row md:items-start md:gap-8">
      <nav aria-label="Transcript filters" data-filters class="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:sticky md:top-4 md:mx-0 md:w-52 md:shrink-0 md:flex-col md:overflow-visible md:px-0 md:pb-0">
        ${FILTERS.map((filter) => renderFilter(run, filter, show, count(filter.show)))}
      </nav>
      <div class="min-w-0 flex-1">${listed}</div>
    </div>
    ${live ? html`<button type="button" id="new-activity" hidden class="${NEW_ACTIVITY}">↓ New activity</button>` : ''}`;
  return layout(`${run.worker} transcript`, null, live, assets, body);
};
