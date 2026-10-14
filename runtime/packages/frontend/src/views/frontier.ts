import { html } from 'hono/html';
import { isGithubRepository, isGithubUrl, ticketKey, type DispatchFailure, type DispatchRecord, type DispatchState, type RepositoryFrontier, type SpecRef, type Ticket } from '@forge/shared';
import type { HtmlEscapedString } from 'hono/utils/html';
import { formatDuration } from '../format.ts';
import { type Rendered, externalLink, TD, PILL, renderTimestamp, SECTION_TITLE, ERROR_CALLOUT, EMPTY, CARD, TABLE, TH, ROW, renderAttemptsLink, renderDate, type AssetHrefs, PAGE_TITLE, layout } from './shared.ts';

const POLLED = 'ml-auto text-sm text-muted';

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
  exceeded: 'Exceeded',
};

const failureText = ({ reason, detail }: DispatchRecord): string | null => {
  if (reason === null) return null;
  const label = FAILURE_LABEL[reason];
  if (reason === 'exceeded') return detail === null ? label : `${label} ${detail}`;
  return detail === null || detail.trim() === '' ? label : `${label}: ${detail}`;
};

const DISPATCH_ELAPSED = 'ml-1.5 text-xs tabular-nums text-muted';

const QUEUED_TONE = 'text-muted ring-1 ring-line ring-inset';

const renderDispatchElapsed = ({ startedAt, endedAt }: DispatchRecord): Rendered =>
  endedAt === null
    ? html` <span class="${DISPATCH_ELAPSED}" data-dispatch-elapsed data-elapsed-since="${startedAt}"></span>`
    : html` <span class="${DISPATCH_ELAPSED}" data-dispatch-elapsed>${formatDuration(startedAt, endedAt)}</span>`;

const renderDispatch = (ticket: Ticket, dispatch: DispatchRecord | undefined): Rendered => {
  if (ticket.forgeReady && ticket.blocked) {
    return html`<td class="${TD} min-w-48" data-dispatch="queued"><span class="${PILL} ${QUEUED_TONE}">queued</span></td>`;
  }
  if (dispatch === undefined) return html`<td class="${TD}"></td>`;
  const badge = html`<span class="${PILL} ${DISPATCH_TONE[dispatch.state]}">${dispatch.state}</span>`;
  const failure = failureText(dispatch);
  return html`<td class="${TD} min-w-48" data-dispatch="${dispatch.state}">${dispatch.runId === null
      ? badge
      : html`<a href="/runs/${encodeURIComponent(dispatch.runId)}" class="rounded-full no-underline hover:opacity-80">${badge}</a>`}${renderDispatchElapsed(dispatch)}${failure === null
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
  attempted: ReadonlySet<string>,
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
                    : html`#${ticket.number}`}${attempted.has(ticketKey(repository, ticket.number))
                    ? html` <span class="ml-1 text-xs">${renderAttemptsLink({ repository, number: ticket.number }, 'attempts')}</span>`
                    : ''}</td>
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
  attempted: ReadonlySet<string>,
  assets: AssetHrefs,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const byTicket = new Map(
    dispatches.map((dispatch) => [ticketKey(dispatch.repository, dispatch.number), dispatch]),
  );
  const body = html`<h1 class="${PAGE_TITLE}">Frontier</h1>
    ${frontier.length === 0
      ? html`<p class="${EMPTY}">No managed repositories have been polled yet.</p>`
      : frontier.map((repository) => renderRepository(repository, byTicket, attempted))}`;
  return layout('Frontier', 'work', true, assets, body);
};
