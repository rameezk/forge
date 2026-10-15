import { html } from 'hono/html';
import { isGithubRepository, isGithubUrl, ticketKey, type DispatchFailure, type DispatchRecord, type RepositoryFrontier, type RevisionRecord, type SpecRef } from '@forge/shared';
import type { HtmlEscapedString } from 'hono/utils/html';
import { buildLanes, COLUMNS, totals, type BoardCard, type BoardLane, type ColumnKey } from '../board.ts';
import { type Rendered, externalLink, PILL, renderTimestamp, SECTION_TITLE, ERROR_CALLOUT, EMPTY, renderAttemptsLink, renderDate, type AssetHrefs, PAGE_TITLE, layout } from './shared.ts';

const ROW_GRID = 'grid grid-cols-9';

const LANE_HEAD = 'sticky left-0 w-[calc(100vw-2.25rem)] max-w-full';

const POLLED = 'ml-auto text-sm text-muted';

const MUTED_LINE = 'm-0 mt-1 text-xs text-muted';

const RUNNING_TONE = 'bg-raised text-fg';

const REVISING_TONE = 'bg-warning-soft text-warning';

const QUEUED_TONE = 'text-muted ring-1 ring-line ring-inset';

const ELAPSED = 'ml-1.5 text-xs tabular-nums text-muted';

const CLOSED_PULL_REQUEST = 'Pull request closed';

const FAILURE_LABEL: Record<DispatchFailure, string> = {
  errored: 'Run errored',
  'no-pull-request': 'No pull request',
  'skill-not-found': 'Skill not found',
  'devshell-failed': 'devShell failed',
  interrupted: 'Interrupted',
  exceeded: 'Exceeded',
};

const failureText = ({ reason, detail }: DispatchRecord): string | null => {
  if (reason === null) return null;
  const label = FAILURE_LABEL[reason];
  if (reason === 'exceeded') return detail === null ? label : `${label} ${detail}`;
  return detail === null || detail.trim() === '' ? label : `${label}: ${detail}`;
};

const specTooltip = (parent: SpecRef | null): string | null => (parent === null ? null : `#${parent.number} ${parent.title}`);

const renderElapsedSince = (since: string): Rendered =>
  html`<span class="${ELAPSED}" data-elapsed-since="${since}"></span>`;

const renderRunning = ({ dispatch }: BoardCard): Rendered => {
  if (dispatch === undefined) return '';
  const pill = html`<span class="${PILL} ${RUNNING_TONE}">running</span>`;
  return html`<p class="${MUTED_LINE}">${dispatch.runId === null
    ? pill
    : html`<a href="/runs/${encodeURIComponent(dispatch.runId)}" class="rounded-full no-underline hover:opacity-80">${pill}</a>`}${renderElapsedSince(dispatch.startedAt)}</p>`;
};

const renderInReview = ({ dispatch, revising }: BoardCard): Rendered => {
  const pullRequest = dispatch?.pullRequest;
  if (dispatch === undefined || pullRequest == null) return '';
  const label = `PR #${pullRequest.number}`;
  return html`<p class="${MUTED_LINE}">${isGithubUrl(pullRequest.url) ? externalLink(pullRequest.url, label) : label}${dispatch.endedAt === null ? '' : renderElapsedSince(dispatch.endedAt)}${revising ? html` <span data-revising class="${PILL} ${REVISING_TONE}">revising</span>` : ''}</p>`;
};

const renderFailure = ({ dispatch }: BoardCard): Rendered => {
  const text = dispatch?.state === 'failed' ? failureText(dispatch) : CLOSED_PULL_REQUEST;
  return text === null
    ? ''
    : html`<p class="m-0 mt-1 line-clamp-3 text-xs break-words whitespace-pre-line text-muted" title="${text}">${text}</p>`;
};

const renderBlocked = ({ ticket }: BoardCard): Rendered =>
  html`<p class="${MUTED_LINE}">${ticket.forgeReady ? html`<span data-queued class="${PILL} ${QUEUED_TONE}">queued</span> ` : ''}blocked</p>`;

const renderDetails = (card: BoardCard): Rendered => {
  switch (card.column) {
    case 'blocked':
      return renderBlocked(card);
    case 'running':
      return renderRunning(card);
    case 'in-review':
      return renderInReview(card);
    case 'failed':
      return renderFailure(card);
    default:
      return html`<p class="${MUTED_LINE}">${renderDate(card.ticket.createdAt)}</p>`;
  }
};

const renderCard = (repository: string, card: BoardCard, attempted: ReadonlySet<string>): Rendered => {
  const { ticket } = card;
  const tooltip = specTooltip(ticket.parent);
  return html`<article data-ticket="${ticket.number}"${tooltip === null ? '' : html` title="${tooltip}"`} class="rounded-md border border-line bg-surface p-2 text-sm">
    <p class="m-0 tabular-nums">${isGithubUrl(ticket.url) ? externalLink(ticket.url, `#${ticket.number}`) : html`#${ticket.number}`}${attempted.has(ticketKey(repository, ticket.number))
      ? html` <span class="ml-1 text-xs">${renderAttemptsLink({ repository, number: ticket.number }, 'attempts')}</span>`
      : ''}</p>
    <p class="m-0 mt-1 break-words">${ticket.title}</p>
    ${renderDetails(card)}
  </article>`;
};

const renderPolled = (polledAt: string | null): Rendered =>
  polledAt === null
    ? html`<span class="${POLLED}">Never polled</span>`
    : html`<span class="${POLLED}">Last polled ${renderTimestamp(polledAt)}</span>`;

const PERSON_ICON = html`<svg data-person role="img" aria-label="A person acts here" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" class="shrink-0 text-muted"><title>A person acts here</title><circle cx="8" cy="5" r="3" /><path d="M2 14c0-3.3 2.7-5 6-5s6 1.7 6 5z" /></svg>`;

const renderColumnHeaders = (counts: Record<ColumnKey, number>): Rendered =>
  html`<div class="${ROW_GRID}">${COLUMNS.map(
    ({ key, title, subtitle, person }) => html`<div data-column-header="${key}" class="border-b border-line bg-raised px-3 py-2">
      <span class="flex items-center gap-1.5"><span data-column-title class="text-[0.7rem] font-semibold uppercase tracking-[0.06em] text-fg">${title}</span>${person ? PERSON_ICON : ''}<span data-column-total class="ml-auto text-xs tabular-nums text-muted">${counts[key]}</span></span>
      <span data-column-subtitle class="block text-xs text-muted">${subtitle}</span>
    </div>`,
  )}</div>`;

const renderLane = (lane: BoardLane, attempted: ReadonlySet<string>): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<section class="border-t border-line" data-repository="${lane.repository}"${lane.lastError === null ? '' : html` data-stale`}>
    <div class="${LANE_HEAD}">
    <header class="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-3 py-2">
      <h2 class="${SECTION_TITLE}">${lane.repository}</h2>
      ${isGithubRepository(lane.github)
        ? externalLink(`https://github.com/${lane.github}`, lane.github)
        : html`<span class="text-muted">${lane.github}</span>`}
      ${renderPolled(lane.polledAt)}
    </header>
    ${lane.lastError === null
      ? ''
      : html`<p class="${ERROR_CALLOUT} mx-3 mb-2" data-poll-error>Last poll failed ${renderTimestamp(lane.lastError.failedAt)}: ${lane.lastError.message}</p>`}
    </div>
    <div class="${ROW_GRID}">${COLUMNS.map(
      ({ key }) => html`<div data-column="${key}" class="flex min-h-12 flex-col gap-2 border-l border-line p-2 first:border-l-0">${lane.columns[key].map((card) => renderCard(lane.repository, card, attempted))}</div>`,
    )}</div>
  </section>`;

export const renderBoard = (
  frontier: RepositoryFrontier[],
  dispatches: DispatchRecord[],
  revisions: RevisionRecord[],
  attempted: ReadonlySet<string>,
  assets: AssetHrefs,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const lanes = buildLanes(frontier, new Map(dispatches.map((dispatch) => [ticketKey(dispatch.repository, dispatch.number), dispatch])), revisions);
  const body = html`<h1 class="${PAGE_TITLE}">Board</h1>
    ${lanes.length === 0
      ? html`<p class="${EMPTY}">No managed repositories have been polled yet.</p>`
      : html`<div data-board class="overflow-x-auto rounded-lg border border-line bg-surface">
          <div class="min-w-[96rem]">
            ${renderColumnHeaders(totals(lanes))}
            ${lanes.map((lane) => renderLane(lane, attempted))}
          </div>
        </div>`}`;
  return layout('Board', 'board', true, assets, body);
};
