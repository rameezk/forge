import { html } from 'hono/html';
import { isGithubRepository, isGithubUrl, ticketKey, type DispatchFailure, type ConflictResolutionRecord, type DispatchRecord, type RepositoryFrontier, type RevisionRecord, type RunRecord, type SpecRef, type Ticket } from '@forge/shared';
import type { HtmlEscapedString } from 'hono/utils/html';
import { formatElapsed } from '../format.ts';
import { buildLanes, COLUMNS, specBands, totals, type BoardCard, type BoardLane, type ColumnKey, type Columns, type SpecBand } from '../board.ts';
import { type Rendered, externalLink, PILL, renderTimestamp, SECTION_TITLE, ERROR_CALLOUT, EMPTY, renderAttemptsLink, renderDate, type Display, PAGE_TITLE, layout } from './shared.ts';

const ROW_GRID = 'grid grid-cols-9';

const LANE_HEAD = 'sticky left-0 w-[calc(100vw-2.25rem)] max-w-full';

const POLLED = 'ml-auto text-sm text-muted';

const MUTED_LINE = 'm-0 mt-1 text-xs text-muted';

const RUNNING_TONE = 'bg-raised text-fg';

const REVISING_TONE = 'bg-warning-soft text-warning';

const QUEUED_TONE = 'text-muted ring-1 ring-line ring-inset';

const HUMAN_TONE = 'text-accent-text ring-1 ring-line ring-inset';

const MERGED_TONE = 'bg-success-soft text-success';

const ELAPSED = 'ml-1.5 text-xs tabular-nums text-muted';

const FAILURE_LINE = 'm-0 mt-1 line-clamp-4 text-xs break-words whitespace-pre-line text-muted';

const CLOSED_PULL_REQUEST = 'Pull request closed';

const FAILURE_LABEL: Record<DispatchFailure, string> = {
  errored: 'Run errored',
  'no-pull-request': 'No pull request',
  draft: 'Pull request still a draft',
  'check-failed': 'Required check failed',
  'check-pending': 'Required check pending',
  'skill-not-found': 'Skill not found',
  'devshell-failed': 'devShell failed',
  interrupted: 'Interrupted',
  exceeded: 'Exceeded',
  'not-started': 'Did not start',
};

const repeatedStart = ({ reason, failedStarts }: DispatchRecord): number | null =>
  reason === 'not-started' && failedStarts !== null && failedStarts > 1 ? failedStarts : null;

const detailSuffix = ({ detail }: DispatchRecord): string =>
  detail === null || detail.trim() === '' ? '' : `: ${detail}`;

const failureText = (dispatch: DispatchRecord): string | null => {
  const { reason, detail } = dispatch;
  if (reason === null) return null;
  const times = repeatedStart(dispatch);
  const label = times === null ? FAILURE_LABEL[reason] : `${FAILURE_LABEL[reason]} (${times} times)`;
  if (reason === 'exceeded') return detail === null ? label : `${label} ${detail}`;
  return `${label}${detailSuffix(dispatch)}`;
};

const SPEC_LINE = 'm-0 mt-1 truncate text-xs text-muted [&_a]:text-muted [&_a:hover]:text-accent-text';

const renderSpecLine = (parent: SpecRef): Rendered =>
  html`<p data-spec-line title="#${parent.number} ${parent.title}" class="${SPEC_LINE}">↳ ${isGithubUrl(parent.url) ? externalLink(parent.url, `#${parent.number}`) : html`#${parent.number}`} ${parent.title}</p>`;

const renderElapsedSince = (since: string): Rendered =>
  html`<span class="${ELAPSED}" data-elapsed-since="${since}"></span>`;

const startOf = (runs: ReadonlyMap<string, RunRecord>, runId: string | null, fallback: string): string => {
  const run = runId === null ? undefined : runs.get(runId);
  return run === undefined ? fallback : (run.harnessStartTime ?? run.startTime);
};

const renderPill = (runId: string | null, pill: Rendered): Rendered =>
  runId === null ? pill : html`<a href="/runs/${encodeURIComponent(runId)}" class="rounded-full no-underline hover:opacity-80">${pill}</a>`;

const renderRunning = ({ dispatch }: BoardCard, runs: ReadonlyMap<string, RunRecord>): Rendered => {
  if (dispatch === undefined) return '';
  const pill = html`<span class="${PILL} ${RUNNING_TONE}">running</span>`;
  return html`<p class="${MUTED_LINE}">${renderPill(dispatch.runId, pill)}${renderElapsedSince(startOf(runs, dispatch.runId, dispatch.startedAt))}</p>`;
};

const renderRevising = (revision: RevisionRecord, runs: ReadonlyMap<string, RunRecord>): Rendered => {
  const pill = html`<span data-revising class="${PILL} ${REVISING_TONE}">revising</span>`;
  return html` <span class="whitespace-nowrap">${renderPill(runs.has(revision.runId) ? revision.runId : null, pill)}${renderElapsedSince(startOf(runs, revision.runId, revision.startedAt))}</span>`;
};

const renderConflictFailedStart = ({ failedStarts, endedAt, startedAt, detail }: ConflictResolutionRecord): Rendered => {
  const times = failedStarts ?? 1;
  const since = endedAt ?? startedAt;
  const text = detail === null || detail.trim() === '' ? '' : `: ${detail}`;
  return html`<p data-conflict-failed-start class="${FAILURE_LINE}" title="Conflict resolution did not start${text}">Conflict resolution did not start (${times} ${times === 1 ? 'time' : 'times'}, last <span data-elapsed-since="${since}">${formatElapsed(Date.now() - Date.parse(since))}</span> ago)${text}</p>`;
};

const renderInReview = ({ dispatch, revision, failedStart }: BoardCard, runs: ReadonlyMap<string, RunRecord>): Rendered => {
  const pullRequest = dispatch?.pullRequest;
  if (dispatch === undefined || pullRequest == null) return '';
  const label = `PR #${pullRequest.number}`;
  return html`<p class="${MUTED_LINE}">${isGithubUrl(pullRequest.url) ? externalLink(pullRequest.url, label) : label}${revision === undefined ? '' : renderRevising(revision, runs)}</p>${failedStart === undefined ? '' : renderConflictFailedStart(failedStart)}`;
};

const renderFailedStart = (dispatch: DispatchRecord, text: string): Rendered => {
  const times = repeatedStart(dispatch);
  const since = dispatch.endedAt ?? dispatch.startedAt;
  return html`<p class="${FAILURE_LINE}" title="${text}">Did not start (${times} times, last <span data-elapsed-since="${since}">${formatElapsed(Date.now() - Date.parse(since))}</span> ago)${detailSuffix(dispatch)}</p>`;
};

const renderFailure = ({ dispatch }: BoardCard): Rendered => {
  const text = dispatch?.state === 'failed' ? failureText(dispatch) : CLOSED_PULL_REQUEST;
  if (text === null) return '';
  return dispatch !== undefined && repeatedStart(dispatch) !== null
    ? renderFailedStart(dispatch, text)
    : html`<p class="${FAILURE_LINE}" title="${text}">${text}</p>`;
};

const renderBlockers = (blockedBy: readonly number[], github: string): Rendered => {
  if (blockedBy.length === 0) return html`blocked`;
  const links = blockedBy.map((number) =>
    isGithubRepository(github) ? externalLink(`https://github.com/${github}/issues/${number}`, `#${number}`) : html`#${number}`,
  );
  return html`blocked by ${links.map((link, index) => html`${index === 0 ? '' : ', '}${link}`)}`;
};

const renderBlocked = ({ ticket }: { ticket: Ticket }, github: string): Rendered =>
  html`<p class="${MUTED_LINE}">${ticket.forgeReady ? html`<span data-queued class="${PILL} ${QUEUED_TONE}">queued</span> ` : ''}${ticket.forHuman ? html`<span data-ready-for-human class="${PILL} ${HUMAN_TONE}">ready-for-human</span> ` : ''}${renderBlockers(ticket.blockedBy, github)}</p>`;

const personIcon = (label: string): Rendered =>
  html`<svg data-person role="img" aria-label="${label}" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" class="text-accent-text"><title>${label}</title><circle cx="8" cy="5" r="3" /><path d="M2 14c0-3.3 2.7-5 6-5s6 1.7 6 5z" /></svg>`;

const PERSON_ICON = personIcon('A person acts here');

const BUILT_BY_PERSON_ICON = personIcon('Built by a person');

const renderDone = ({ ticket, dispatch }: BoardCard & { column: 'done' }, timeZone: string): Rendered => {
  const pullRequest = dispatch?.pullRequest;
  const merged = pullRequest != null && pullRequest.state === 'merged';
  return html`<p class="${MUTED_LINE}">${merged ? html`<span data-merged class="${PILL} ${MERGED_TONE}">merged</span> ${isGithubUrl(pullRequest.url) ? externalLink(pullRequest.url, `PR #${pullRequest.number}`) : html`PR #${pullRequest.number}`} ` : ''}${renderTimestamp(ticket.closedAt, timeZone)}${ticket.forHuman ? html` <span class="ml-1 inline-flex align-middle">${BUILT_BY_PERSON_ICON}</span>` : ''}</p>`;
};

const renderDetails = (card: BoardCard, github: string, timeZone: string, runs: ReadonlyMap<string, RunRecord>): Rendered => {
  switch (card.column) {
    case 'blocked':
      return renderBlocked(card, github);
    case 'running':
      return renderRunning(card, runs);
    case 'in-review':
      return renderInReview(card, runs);
    case 'failed':
      return renderFailure(card);
    case 'done':
      return renderDone(card, timeZone);
    default:
      return html`<p class="${MUTED_LINE}">${renderDate(card.ticket.createdAt, timeZone)}</p>`;
  }
};

const renderCard = (repository: string, github: string, card: BoardCard, grouped: boolean, attempted: ReadonlySet<string>, timeZone: string, runs: ReadonlyMap<string, RunRecord>): Rendered => {
  const { ticket } = card;
  const parent = grouped || card.column === 'to-refine' ? null : card.ticket.parent;
  return html`<article data-ticket="${ticket.number}" class="rounded-md border border-line bg-surface p-2 text-sm">
    <p class="m-0 tabular-nums">${isGithubUrl(ticket.url) ? externalLink(ticket.url, `#${ticket.number}`) : html`#${ticket.number}`}${attempted.has(ticketKey(repository, ticket.number))
      ? html` <span class="ml-1 text-xs">${renderAttemptsLink({ repository, number: ticket.number }, 'attempts')}</span>`
      : ''}</p>
    <p class="m-0 mt-1 break-words">${ticket.title}</p>
    ${parent === null ? '' : renderSpecLine(parent)}
    ${renderDetails(card, github, timeZone, runs)}
  </article>`;
};

const renderPolled = (polledAt: string | null, timeZone: string): Rendered =>
  polledAt === null
    ? html`<span class="${POLLED}">Never polled</span>`
    : html`<span class="${POLLED}">Last polled ${renderTimestamp(polledAt, timeZone)}</span>`;

const renderColumnHeaders = (counts: Record<ColumnKey, number>): Rendered =>
  html`<div class="sticky top-0 z-10 shadow-[0_1px_0_var(--color-line)] ${ROW_GRID}">${COLUMNS.map(
    ({ key, title, subtitle, hint, person }) => html`<div data-column-header="${key}" class="border-b border-line bg-raised px-2 py-2">
      <span class="flex h-4 items-center gap-1"><span data-column-title class="min-w-0 truncate text-[0.7rem] font-semibold leading-4 uppercase tracking-[0.05em] text-fg">${title}</span><span class="ml-auto flex shrink-0 items-center gap-1.5">${person ? html`<span class="flex h-4 shrink-0 items-center">${PERSON_ICON}</span>` : ''}<span data-column-total class="text-xs leading-4 tabular-nums text-muted">${counts[key]}</span></span></span>
      <span data-column-subtitle title="${hint ?? subtitle}" class="mt-0.5 block truncate text-[0.6875rem] leading-4 text-muted${hint === null ? '' : ' cursor-help underline decoration-dotted decoration-line underline-offset-[3px]'}">${subtitle}</span>
    </div>`,
  )}</div>`;

const renderLaneCounts = (lane: BoardLane): Rendered => {
  const populated = COLUMNS.filter(({ key }) => lane.columns[key].length > 0);
  return populated.length === 0
    ? html`<span data-lane-empty class="hidden text-sm text-muted group-data-[collapsed]:inline">Nothing in flight</span>`
    : html`<span class="hidden flex-wrap gap-x-3 text-sm text-muted group-data-[collapsed]:flex">${populated.map(
        ({ key, title }) => html`<span data-lane-count="${key}" class="tabular-nums">${title} ${lane.columns[key].length}</span>`,
      )}</span>`;
};

const renderRow = (repository: string, github: string, columns: Columns, grouped: boolean, attempted: ReadonlySet<string>, timeZone: string, runs: ReadonlyMap<string, RunRecord>): Rendered =>
  html`<div class="${ROW_GRID}">${COLUMNS.map(
    ({ key }) => html`<div data-column="${key}" class="flex min-h-12 flex-col gap-2 border-l border-line p-2 first:border-l-0">${columns[key].map((card) => renderCard(repository, github, card, grouped, attempted, timeZone, runs))}</div>`,
  )}</div>`;

const renderBand = (lane: BoardLane, { spec, columns, count }: SpecBand, attempted: ReadonlySet<string>, timeZone: string, runs: ReadonlyMap<string, RunRecord>): Rendered =>
  html`<div data-spec-band="${spec === null ? 'none' : spec.number}">
    <header data-band-head class="flex items-baseline gap-2.5 border-t border-dashed border-line bg-bg px-3 py-1.5 text-[0.8125rem]">${spec === null
      ? html`<span class="font-semibold text-muted">No spec</span>`
      : html`<span class="tabular-nums">${isGithubUrl(spec.url) ? externalLink(spec.url, `#${spec.number}`) : html`#${spec.number}`}</span><span class="font-semibold">${spec.title}</span>`}<span class="tabular-nums text-muted">${count} ${count === 1 ? 'ticket' : 'tickets'}</span></header>
    ${renderRow(lane.repository, lane.github, columns, true, attempted, timeZone, runs)}
  </div>`;

const renderLane = (lane: BoardLane, grouped: boolean, attempted: ReadonlySet<string>, timeZone: string, runs: ReadonlyMap<string, RunRecord>): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const empty = COLUMNS.every(({ key }) => lane.columns[key].length === 0);
  return html`<section class="group border-t border-line" data-repository="${lane.repository}"${empty ? html` data-empty data-collapsed` : ''}${lane.lastError === null ? '' : html` data-stale`}>
    <div class="${LANE_HEAD}">
    <header data-lane-toggle role="button" tabindex="0" aria-expanded="${empty ? 'false' : 'true'}" class="flex cursor-pointer flex-wrap items-baseline gap-x-4 gap-y-1 px-3 py-2">
      <span data-lane-chevron aria-hidden="true" class="inline-block self-center w-3 shrink-0 rotate-90 text-center text-[0.65rem] text-muted transition-transform group-data-[collapsed]:rotate-0">▶</span>
      <h2 class="${SECTION_TITLE}">${lane.repository}</h2>
      ${isGithubRepository(lane.github)
        ? externalLink(`https://github.com/${lane.github}`, lane.github)
        : html`<span class="text-muted">${lane.github}</span>`}
      ${renderLaneCounts(lane)}
      ${renderPolled(lane.polledAt, timeZone)}
    </header>
    ${lane.lastError === null
      ? ''
      : html`<p class="${ERROR_CALLOUT} mx-3 mb-2" data-poll-error>Last poll failed ${renderTimestamp(lane.lastError.failedAt, timeZone)}: ${lane.lastError.message}</p>`}
    </div>
    <div class="group-data-[collapsed]:hidden">${grouped
      ? specBands(lane.columns).map((band) => renderBand(lane, band, attempted, timeZone, runs))
      : renderRow(lane.repository, lane.github, lane.columns, false, attempted, timeZone, runs)}</div>
  </section>`;
};

export interface RunningSlots {
  running: number;
  limit: number;
}

const FULL_TONE = 'bg-warning-soft text-warning';
const OPEN_TONE = 'bg-raised text-fg';

const renderRunningLimit = ({ running, limit }: RunningSlots): Rendered => {
  const full = running >= limit;
  return html`<span data-running-limit${full ? html` data-full` : ''} title="Dispatches and revisions running, out of the global limit" class="${PILL} mb-3 ${full ? FULL_TONE : OPEN_TONE} tabular-nums">Running ${running} / ${limit}</span>`;
};

export type Grouping = 'none' | 'spec';

const GROUPINGS: readonly { value: Grouping; label: string; href: string }[] = [
  { value: 'none', label: 'None', href: '/' },
  { value: 'spec', label: 'Spec', href: '/?group=spec' },
];

const renderGroupControl = (grouping: Grouping): Rendered =>
  html`<div class="flex items-center gap-2 mb-3"><span id="group-label" class="text-xs text-muted">Group by</span><div data-group-control role="group" aria-labelledby="group-label" class="inline-flex overflow-hidden rounded-md border border-line bg-surface text-[0.8125rem]">${GROUPINGS.map(
    ({ value, label, href }) => html`<a href="${href}"${value === grouping ? html` aria-current="true"` : ''} class="px-3 py-1 no-underline ${value === grouping ? 'bg-raised font-semibold text-fg' : 'text-muted hover:text-fg'}${value === 'none' ? '' : ' border-l border-line'}">${label}</a>`,
  )}</div></div>`;

export const renderBoard = (
  frontier: RepositoryFrontier[],
  dispatches: DispatchRecord[],
  revisions: RevisionRecord[],
  conflictResolutions: ConflictResolutionRecord[],
  runs: ReadonlyMap<string, RunRecord>,
  attempted: ReadonlySet<string>,
  slots: RunningSlots,
  display: Display,
  grouping: Grouping = 'none',
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const lanes = buildLanes(frontier, new Map(dispatches.map((dispatch) => [ticketKey(dispatch.repository, dispatch.number), dispatch])), revisions, conflictResolutions);
  const body = html`<div class="flex flex-wrap items-center justify-between gap-x-4"><h1 class="${PAGE_TITLE}">Board</h1><div class="flex flex-wrap items-center gap-x-4">${renderGroupControl(grouping)}${renderRunningLimit(slots)}</div></div>
    ${lanes.length === 0
      ? html`<p class="${EMPTY}">No managed repositories have been polled yet.</p>`
      : html`<div data-board class="min-h-0 flex-1 overflow-auto rounded-lg border border-line bg-surface">
          <div class="min-w-[96rem]">
            ${renderColumnHeaders(totals(lanes))}
            ${lanes.map((lane) => renderLane(lane, grouping === 'spec', attempted, display.timeZone, runs))}
          </div>
        </div>`}`;
  return layout('Board', 'board', true, display, body, 'always');
};
