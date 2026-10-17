import { html } from 'hono/html';
import { cohortHref, cohortLabel, isGithubUrl, type ConfigFingerprint, type ConflictResolutionFailure, type PullRequestState, type PullRequestWorkloadRecord, type RevisionFailure, type RevisionState, type RunRecord, type RunStatus, type RunTicket } from '@forge/shared';
import type { HtmlEscapedString } from 'hono/utils/html';
import { cacheHitRate, formatBudget, formatCost, formatDate, formatDuration, formatSpan, formatSpend, formatStarted, formatTokens } from '../format.ts';
import { DEFAULT_EFFORT } from '../request-record.ts';

export type Rendered = HtmlEscapedString | Promise<HtmlEscapedString> | '';

const FAILURE_LABEL: Record<RevisionFailure | ConflictResolutionFailure, string> = {
  unanswered: 'Unanswered',
  crashed: 'Crashed',
  'not-merged': 'Not merged',
  'still-conflicting': 'Still conflicting',
  'check-failed': 'Required check failed',
  'check-pending': 'Required check pending',
};

export const pullRequestFailureText = ({ reason, detail }: PullRequestWorkloadRecord): string | null => {
  if (reason === null) return null;
  const label = FAILURE_LABEL[reason];
  return detail === null || detail.trim() === '' ? label : `${label}: ${detail}`;
};

const NO_REASON_RECORDED = 'no reason recorded';

export const settledOutcome = (workload: PullRequestWorkloadRecord | undefined): PullRequestWorkloadRecord | null =>
  workload === undefined || workload.state === 'running' ? null : workload;

export const workloadOutcomeText = (workload: PullRequestWorkloadRecord): string | null =>
  pullRequestFailureText(workload) ?? (workload.state === 'error' ? NO_REASON_RECORDED : null);

type Page = 'board' | 'runs' | 'insights';

const NAV: { page: Page; href: string; label: string }[] = [
  { page: 'board', href: '/', label: 'Board' },
  { page: 'runs', href: '/runs', label: 'Runs' },
  { page: 'insights', href: '/insights', label: 'Insights' },
];

export const NAV_PAGES: ReadonlySet<string> = new Set(NAV.map(({ href }) => href));

export interface AssetHrefs {
  stylesheet: string;
  logo: string;
  idiomorph: string;
  client: string;
}

export interface Display {
  assets: AssetHrefs;
  timeZone: string;
  version?: string;
}

const FOCUS_RINGS = '[&_:where(:focus-visible)]:outline-2 [&_:where(:focus-visible)]:outline-offset-2 [&_:where(:focus-visible)]:outline-accent';

export const PAGE_TITLE = 'm-0 mb-3 text-xl font-bold';

export const SECTION_TITLE = 'm-0 text-[1.1rem] font-bold';

export const EMPTY = 'm-0 text-muted';

export const LINK = 'rounded-sm font-medium text-accent-text no-underline hover:underline';

export const CALLOUT = 'm-0 rounded-lg px-4 py-2.5 break-words';

export const ERROR_CALLOUT = `${CALLOUT} bg-error-soft text-error`;

export const CARD = 'overflow-x-auto rounded-lg border border-line bg-surface';

export const TABLE = 'w-full border-collapse text-[0.9rem]';

export const TH = 'whitespace-nowrap border-b border-line bg-raised px-3.5 py-2.5 text-left text-[0.7rem] font-semibold uppercase tracking-[0.06em] text-fg';

export const TD = 'border-t border-line px-3.5 py-2.5 align-baseline';

export const ROW = 'hover:bg-bg';

export const NUMERIC_WRAPPING = 'text-right tabular-nums';

export const NUMERIC = `${NUMERIC_WRAPPING} whitespace-nowrap`;

export const NEW_ACTIVITY_BUTTON = html`<button type="button" id="new-activity" hidden class="fixed bottom-6 left-1/2 z-10 -translate-x-1/2 cursor-pointer rounded-full border border-line bg-surface px-4 py-1.5 text-sm font-semibold text-fg shadow-md hover:bg-raised">↓ New activity</button>`;

export const PENDING = 'font-normal italic text-muted';

const NAV_LINK = 'border-b-2 py-1.5 text-[0.9rem] no-underline';

const LIVE_INDICATOR = "ml-auto inline-flex items-center gap-1.5 text-xs text-muted before:size-1.5 before:rounded-full before:bg-current before:content-[''] data-[state=live]:before:bg-success data-[state=reconnecting]:before:bg-warning";

export const externalLink = (href: string, label: string): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<a href="${href}" target="_blank" rel="noopener noreferrer" class="${LINK}">${label}</a>`;

const navLink = (href: string, label: string, current: boolean): HtmlEscapedString | Promise<HtmlEscapedString> =>
  current
    ? html`<a href="${href}" aria-current="page" class="${NAV_LINK} border-accent font-semibold text-fg">${label}</a>`
    : html`<a href="${href}" class="${NAV_LINK} border-transparent text-muted hover:text-fg">${label}</a>`;

const renderHeader = (
  current: Page | null,
  live: boolean,
  assets: AssetHrefs,
  version: string | undefined,
): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<header class="border-b border-line bg-surface">
    <div class="mx-auto flex max-w-[100rem] items-center gap-6 px-4 py-2">
      <a href="/" data-brand class="flex items-center gap-2 rounded-sm text-[1.05rem] font-bold tracking-tight text-fg no-underline"><img src="${assets.logo}" alt="" width="28" height="28" class="size-7" />Forge</a>
      <nav class="flex gap-4">
        ${NAV.map(({ page, href, label }) => navLink(href, label, page === current))}
      </nav>
      ${live ? html`<span id="live" role="status" data-live${version === undefined ? '' : html` data-version="${version}"`} hidden class="${LIVE_INDICATOR}"></span>` : ''}
    </div>
  </header>`;

export const layout = (
  title: string,
  current: Page | null,
  live: boolean,
  { assets, timeZone, version }: Display,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
  fitsViewport = false,
): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<!doctype html>
    <html lang="en" class="scheme-light-dark">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} | Forge</title>
        <link rel="icon" type="image/svg+xml" href="${assets.logo}" />
        <link rel="stylesheet" href="${assets.stylesheet}" />
        <script src="${assets.idiomorph}" defer></script>
        <script src="${assets.client}" defer></script>
      </head>
      <body class="bg-bg text-[15px] text-fg ${FOCUS_RINGS}${fitsViewport ? ' lg:flex lg:h-dvh lg:flex-col' : ''}">
        ${renderHeader(current, live, assets, version)}
        <main class="mx-auto w-full max-w-[100rem] px-4 ${fitsViewport ? 'py-8 lg:min-h-0 lg:flex-1 lg:overflow-hidden lg:py-4' : 'py-8'}">${body}</main>
        <footer class="shrink-0 border-t border-line text-xs text-muted"><div class="mx-auto w-full max-w-[100rem] px-4 py-4">Times in ${timeZone}</div></footer>
      </body>
    </html>`;

export const BADGE = 'shrink-0 rounded px-1.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-[0.05em]';

const UNCONFIRMED_BADGE = html`<span class="${BADGE} ml-1.5 bg-warning-soft text-warning" data-badge="unconfirmed" title="forge could not confirm OpenRouter's billed cost for every generation, so this may not be the whole cost">unconfirmed</span>`;

export const ESTIMATED_BADGE = html`<span class="${BADGE} ml-1.5 bg-line text-fg" data-badge="estimated" title="Includes forge's estimate at OpenRouter's list price for generations not yet billed, replaced as generations are billed">estimated</span>`;

const PENDING_BADGE = html`<span class="${BADGE} ml-1.5 bg-line text-fg" data-badge="pending" title="Billed by OpenRouter so far. Rises as the run's generations are billed, trailing them by a minute or two.">pending</span>`;

export type Cost = Pick<RunRecord, 'costStatus' | 'costUsd' | 'costEstimated'>;

const costBadge = (run: Cost): Rendered => {
  if (run.costEstimated) return ESTIMATED_BADGE;
  return run.costStatus === 'pending' ? PENDING_BADGE : '';
};

export const SUBSCRIPTION_BADGE = html`<span class="${BADGE} bg-line text-fg" data-badge="subscription" title="Run on a Claude subscription, so not billed per generation">subscription</span>`;

export const renderCost = (run: Cost): Rendered => {
  if (run.costStatus === 'subscription') return SUBSCRIPTION_BADGE;
  if (run.costStatus === 'pending' && !run.costEstimated && run.costUsd === 0) {
    return html`<span class="${PENDING}">pending</span>`;
  }
  const badge = costBadge(run);
  return html`${formatCost(run.costUsd)}${badge === '' ? '' : html`<wbr>${badge}`}${run.costStatus === 'unconfirmed' ? html`<wbr>${UNCONFIRMED_BADGE}` : ''}`;
};

export const renderRunCost = (run: RunRecord): Rendered => {
  if (run.endTime !== null || run.maxCostUsd === null) return renderCost(run);
  const badge = costBadge(run);
  return html`<span data-spend>${formatSpend(run.costUsd)} / ${formatBudget(run.maxCostUsd)}</span>${badge === '' ? '' : html`<wbr>${badge}`}${run.costStatus === 'unconfirmed' ? html`<wbr>${UNCONFIRMED_BADGE}` : ''}`;
};

export const PILL = "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold before:size-1.5 before:rounded-full before:bg-current before:content-['']";

const STATUS_TONE: Record<RunStatus, string> = {
  success: 'bg-success-soft text-success',
  error: 'bg-error-soft text-error',
  running: 'bg-raised text-fg',
  interrupted: 'bg-warning-soft text-warning',
  exceeded: 'bg-warning-soft text-warning',
};

export const FAILED_TONE = 'bg-error-soft text-error';

export const WORKLOAD_TONE: Record<RevisionState, string> = {
  running: 'bg-raised text-fg',
  ok: 'bg-success-soft text-success',
  error: FAILED_TONE,
  exceeded: 'bg-warning-soft text-warning',
  interrupted: 'bg-warning-soft text-warning',
};

export const renderWorkloadOutcome = (workload: PullRequestWorkloadRecord): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<span class="${PILL} ${WORKLOAD_TONE[workload.state]}" data-outcome="${workload.state}">${workload.state}</span>`;

export const renderStatus = (status: RunStatus): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<span class="${PILL} ${STATUS_TONE[status]}" data-status="${status}">${status}</span>`;

export const renderTimestamp = (iso: string, timeZone: string): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<time datetime="${iso}" title="${iso}" class="whitespace-nowrap">${formatStarted(iso, timeZone)}</time>`;

export const renderDate = (iso: string, timeZone: string): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<time datetime="${iso}" title="${iso}" class="whitespace-nowrap">${formatDate(iso, timeZone)}</time>`;

export const renderRunTicket = (ticket: RunTicket | null): Rendered =>
  ticket === null
    ? ''
    : html`<span class="text-muted">${ticket.repository}</span> ${isGithubUrl(ticket.url)
        ? externalLink(ticket.url, `#${ticket.number}`)
        : html`#${ticket.number}`}`;

export const NOT_RECORDED = html`<span class="${PENDING}">not recorded</span>`;

export const renderTokens = (run: Pick<RunRecord, 'inputTokens' | 'outputTokens'>): string =>
  `${formatTokens(run.inputTokens)} in / ${formatTokens(run.outputTokens)} out`;

export const renderCacheHitRate = (run: RunRecord): Rendered => {
  const rate = cacheHitRate(run);
  return rate === null ? NOT_RECORDED : html`${rate}`;
};

export const PARTIAL_BADGE = html`<span class="${BADGE} ml-1.5 bg-line text-fg" data-badge="partial" title="Some generations have no list-price equivalent, so the total is understated">partial</span>`;

export const configuredEffort = (run: Pick<RunRecord, 'reasoningEffort'>): string =>
  run.reasoningEffort ?? DEFAULT_EFFORT;

type Timed = Pick<RunRecord, 'startTime' | 'endTime' | 'harnessStartTime' | 'timeoutSeconds'>;

export const renderDuration = ({ startTime, endTime, harnessStartTime, timeoutSeconds }: Timed): Rendered =>
  endTime === null
    ? html`<span data-elapsed-since="${harnessStartTime ?? startTime}"${timeoutSeconds === null
        ? ''
        : html` data-elapsed-limit="${formatSpan(timeoutSeconds)}"`}>running</span>`
    : html`${formatDuration(startTime, endTime)}`;

export const BLOCK = 'rounded-lg border bg-surface';

export const STACK = 'flex flex-col gap-3';

export const LABEL = 'm-0 text-xs font-semibold uppercase tracking-[0.05em] text-muted';

export const PROSE = 'm-0 whitespace-pre-wrap break-words font-sans';

export const CODE = 'm-0 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-raised px-3 py-2.5 font-mono text-[0.8rem] leading-relaxed text-fg';

export const INLINE_DISCLOSURE = `cursor-pointer list-none items-center gap-1.5 rounded-sm text-xs text-muted hover:text-fg [&::-webkit-details-marker]:hidden before:inline-block before:w-3 before:shrink-0 before:text-center before:text-[0.6rem] before:transition-transform before:content-['▶'] [[open]>&]:before:rotate-90`;

export const DISCLOSURE = `flex cursor-pointer list-none items-center gap-2.5 rounded-lg px-4 py-2.5 [&::-webkit-details-marker]:hidden before:inline-block before:w-3 before:shrink-0 before:text-center before:text-[0.65rem] before:text-muted before:transition-transform before:content-['▶'] [[open]>&]:before:rotate-90 focus-visible:-outline-offset-2`;

export const PULL_REQUEST_TONE: Record<PullRequestState, string> = {
  open: 'bg-raised text-fg',
  merged: 'bg-success-soft text-success',
  closed: 'bg-warning-soft text-warning',
};

export const SHORT_SHA_LENGTH = 7;

const attemptsPath = (ticket: { repository: string; number: number }): string =>
  `/tickets/${encodeURIComponent(ticket.repository)}/${ticket.number}`;

export const renderAttemptsLink = (ticket: { repository: string; number: number }, label: string): Rendered =>
  html`<a href="${attemptsPath(ticket)}" data-attempts class="${LINK}">${label}</a>`;

export const renderCohortLink = (hash: string | null, fingerprint: ConfigFingerprint | null): Rendered =>
  html`<a href="${cohortHref(hash)}" class="${LINK}">${cohortLabel(fingerprint)}</a>`;
