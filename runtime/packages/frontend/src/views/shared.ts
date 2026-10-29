import { html, raw } from 'hono/html';
import { cohortHref, cohortLabel, isGithubUrl, type ConfigFingerprint, type ConflictResolutionFailure, type DispatchFailure, type DispatchRecord, type DispatchState, type PullRequestState, type PullRequestWorkloadRecord, type RevisionFailure, type RevisionState, type RunRecord, type RunStatus, type RunTicket } from '@forge/shared';
import type { HtmlEscapedString } from 'hono/utils/html';
import { cacheHitRate, formatBudget, formatCost, formatDate, formatDuration, formatSpan, formatSpend, formatStarted, formatTokens } from '../format.ts';
import { renderMarkdown } from '../markdown.ts';
import { DEFAULT_EFFORT } from '../request-record.ts';

export type Rendered = HtmlEscapedString | Promise<HtmlEscapedString> | '';

const FAILURE_LABEL: Record<RevisionFailure | ConflictResolutionFailure, string> = {
  unanswered: 'Unanswered',
  crashed: 'Crashed',
  'not-merged': 'Not merged',
  'still-conflicting': 'Still conflicting',
  'check-failed': 'Required check failed',
  'check-pending': 'Required check pending',
  'not-started': 'Did not start',
  interrupted: 'Interrupted',
  exceeded: 'Exceeded',
};

const DISPATCH_FAILURE_LABEL: Record<DispatchFailure, string> = {
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

export const repeatedStart = ({ reason, failedStarts }: DispatchRecord): number | null =>
  reason === 'not-started' && failedStarts !== null && failedStarts > 1 ? failedStarts : null;

export const detailSuffix = ({ detail }: DispatchRecord): string =>
  detail === null || detail.trim() === '' ? '' : `: ${detail}`;

export interface FailureReason {
  label: string | null;
  detail: string | null;
}

const trimmed = (detail: string | null): string | null => (detail === null || detail.trim() === '' ? null : detail);

export const dispatchFailureReason = (dispatch: DispatchRecord): FailureReason | null => {
  const { reason, detail } = dispatch;
  if (reason === null) return null;
  const times = repeatedStart(dispatch);
  return { label: times === null ? DISPATCH_FAILURE_LABEL[reason] : `${DISPATCH_FAILURE_LABEL[reason]} (${times} times)`, detail: trimmed(detail) };
};

export const dispatchFailureText = (dispatch: DispatchRecord): string | null => {
  const reason = dispatchFailureReason(dispatch);
  if (reason === null) return null;
  const { label, detail } = reason;
  if (dispatch.reason === 'exceeded') return detail === null ? label : `${label} ${detail}`;
  return `${label}${detailSuffix(dispatch)}`;
};

export const pullRequestFailureReason = (workload: PullRequestWorkloadRecord): FailureReason | null => {
  const { reason, detail } = workload;
  if (reason === null) return null;
  const times = 'failedStarts' in workload ? workload.failedStarts : null;
  return { label: times !== null && times > 1 ? `${FAILURE_LABEL[reason]} (${times} times)` : FAILURE_LABEL[reason], detail: trimmed(detail) };
};

export const pullRequestFailureText = (workload: PullRequestWorkloadRecord): string | null => {
  const reason = pullRequestFailureReason(workload);
  return reason === null ? null : reason.detail === null ? reason.label : `${reason.label}: ${reason.detail}`;
};

const NO_REASON_RECORDED = 'no reason recorded';

export const settledOutcome = (workload: PullRequestWorkloadRecord | undefined): PullRequestWorkloadRecord | null =>
  workload === undefined || workload.state === 'running' ? null : workload;

export interface RunOutcome {
  state: string;
  tone: string;
  reason: FailureReason | null;
}

export const runOutcomeOf = (workload: PullRequestWorkloadRecord | undefined, dispatch: DispatchRecord | undefined): RunOutcome | null => {
  const settled = settledOutcome(workload);
  if (settled !== null) return { state: settled.state, tone: WORKLOAD_TONE[settled.state], reason: pullRequestFailureReason(settled) };
  if (dispatch === undefined || dispatch.state === 'running') return null;
  return { state: dispatch.state, tone: WORKLOAD_TONE[dispatch.state], reason: dispatchFailureReason(dispatch) };
};

export interface RunReason extends FailureReason {
  tone: string;
}

export const runReasonOf = (run: Pick<RunRecord, 'status' | 'error'>, outcome: RunOutcome | null): RunReason | null => {
  const stopped = run.status === 'interrupted' || run.status === 'exceeded';
  const tone = stopped ? STOPPED_TONE : outcome?.reason != null ? outcome.tone : FAILED_TONE;
  if (outcome?.reason != null) return { ...outcome.reason, tone };
  if (run.error !== null && run.error.trim() !== '') return { label: null, detail: run.error, tone };
  return outcome?.state === 'failed' ? { label: NO_REASON_RECORDED, detail: null, tone } : null;
};

export const firstLine = (detail: string): string => detail.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';

export const reasonLine = ({ label, detail }: FailureReason): string => {
  const line = detail === null ? null : firstLine(detail);
  return label === null ? (line ?? '') : line === null || line === '' ? label : `${label}: ${line}`;
};

type Page = 'board' | 'workloads' | 'insights';

const NAV: { page: Page; href: string; label: string }[] = [
  { page: 'board', href: '/', label: 'Board' },
  { page: 'workloads', href: '/workloads', label: 'Workloads' },
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

type Fit = 'scroll' | 'desktop' | 'always';

const FIT_WIDTH = { scroll: 'mx-auto max-w-[100rem]', desktop: 'mx-auto max-w-[100rem]', always: '' } as const;

const renderHeader = (
  current: Page | null,
  live: boolean,
  assets: AssetHrefs,
  version: string | undefined,
): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<header class="border-b border-line bg-surface">
    <div class="flex items-center gap-6 px-4 py-2">
      <a href="/" data-brand class="flex items-center gap-2 rounded-sm text-[1.05rem] font-bold tracking-tight text-fg no-underline"><img src="${assets.logo}" alt="" width="28" height="28" class="size-7" />Forge</a>
      <nav class="flex gap-4">
        ${NAV.map(({ page, href, label }) => navLink(href, label, page === current))}
      </nav>
      ${live ? html`<span id="live" role="status" data-live${version === undefined ? '' : html` data-version="${version}"`} hidden class="${LIVE_INDICATOR}"></span>` : ''}
    </div>
  </header>`;

const FIT_BODY = { scroll: '', desktop: ' lg:flex lg:h-dvh lg:flex-col', always: ' flex h-dvh flex-col' } as const;

const FIT_MAIN = {
  scroll: 'py-8',
  desktop: 'py-8 lg:min-h-0 lg:flex-1 lg:overflow-hidden lg:py-4',
  always: 'flex min-h-0 flex-1 flex-col overflow-hidden py-8 lg:pt-6 lg:pb-4',
} as const;

export const layout = (
  title: string,
  current: Page | null,
  live: boolean,
  { assets, timeZone, version }: Display,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
  fit: Fit = 'scroll',
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
      <body class="bg-bg text-[15px] text-fg ${FOCUS_RINGS}${FIT_BODY[fit]}">
        ${renderHeader(current, live, assets, version)}
        <main class="w-full ${FIT_WIDTH[fit]} px-4 ${FIT_MAIN[fit]}">${body}</main>
        <footer class="shrink-0 border-t border-line text-xs text-muted"><div class="px-4 py-4">Times in ${timeZone}</div></footer>
      </body>
    </html>`;

export const BADGE = 'shrink-0 rounded px-1.5 py-0.5 text-[0.65rem] font-bold uppercase tracking-[0.05em]';

const UNCONFIRMED_TITLE = "forge could not confirm OpenRouter's billed cost for every generation, so this may not be the whole cost";

const UNBILLABLE_TITLE = `${UNCONFIRMED_TITLE}. The harness returned generation ids that are not OpenRouter generation ids, so they cannot be billed.`;

const unconfirmedBadge = (unbillable: boolean): Rendered =>
  html`<span class="${BADGE} ml-1.5 bg-warning-soft text-warning" data-badge="unconfirmed" title="${unbillable ? UNBILLABLE_TITLE : UNCONFIRMED_TITLE}">unconfirmed</span>`;

export const ESTIMATED_BADGE = html`<span class="${BADGE} ml-1.5 bg-line text-fg" data-badge="estimated" title="Includes forge's estimate at OpenRouter's list price for generations not yet billed, replaced as generations are billed">estimated</span>`;

const PENDING_TITLE = "Billed by OpenRouter so far. Rises as the run's generations are billed, trailing them by a minute or two.";

export const pendingBadge = (title: string = PENDING_TITLE): Rendered =>
  html`<span class="${BADGE} ml-1.5 bg-line text-fg" data-badge="pending" title="${title}">pending</span>`;

const PENDING_BADGE = pendingBadge();

export type Cost = Pick<RunRecord, 'costStatus' | 'costUsd' | 'costEstimated' | 'unconfirmedEstimateUsd'>;

export const UNCONFIRMED_ESTIMATE_TITLE = "forge's estimate at OpenRouter's list price for generations billing gave up on. Not billed, and kept apart from the billed cost";

const renderUnconfirmedEstimate = (usd: number): Rendered =>
  usd > 0
    ? html` <wbr>+ <span data-unconfirmed-estimate title="${UNCONFIRMED_ESTIMATE_TITLE}">~${formatCost(usd)} unconfirmed estimate</span>`
    : '';

const costBadge = (run: Cost): Rendered => {
  if (run.costEstimated) return ESTIMATED_BADGE;
  return run.costStatus === 'pending' ? PENDING_BADGE : '';
};

export const SUBSCRIPTION_BADGE = html`<span class="${BADGE} bg-line text-fg" data-badge="subscription" title="Run on a Claude subscription, so not billed per generation">subscription</span>`;

export const renderCost = (run: Cost, unbillable = false): Rendered => {
  if (run.costStatus === 'subscription') return SUBSCRIPTION_BADGE;
  if (run.costStatus === 'pending' && !run.costEstimated && run.costUsd === 0) {
    return html`<span class="${PENDING}">pending</span>`;
  }
  const badge = costBadge(run);
  const estimate = renderUnconfirmedEstimate(run.unconfirmedEstimateUsd);
  const billed = estimate === '' ? formatCost(run.costUsd) : html`${formatCost(run.costUsd)} billed`;
  return html`${billed}${estimate}${badge === '' ? '' : html`<wbr>${badge}`}${run.costStatus === 'unconfirmed' ? html`<wbr>${unconfirmedBadge(unbillable)}` : ''}`;
};

export const renderRunCost = (run: RunRecord, unbillable = false): Rendered => {
  if (run.endTime !== null || run.maxCostUsd === null) return renderCost(run, unbillable);
  const badge = costBadge(run);
  return html`<span data-spend>${formatSpend(run.costUsd)} / ${formatBudget(run.maxCostUsd)}</span>${renderUnconfirmedEstimate(run.unconfirmedEstimateUsd)}${badge === '' ? '' : html`<wbr>${badge}`}${run.costStatus === 'unconfirmed' ? html`<wbr>${unconfirmedBadge(unbillable)}` : ''}`;
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

const STOPPED_TONE = 'bg-warning-soft text-warning';

export const WORKLOAD_TONE: Record<RevisionState | DispatchState, string> = {
  running: 'bg-raised text-fg',
  done: 'bg-success-soft text-success',
  failed: FAILED_TONE,
};

export const renderWorkloadOutcome = (workload: PullRequestWorkloadRecord): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<span class="${PILL} ${WORKLOAD_TONE[workload.state]}" data-outcome="${workload.state}">${workload.state}</span>`;

export const renderRunOutcome = ({ state, tone }: RunOutcome): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<span class="${PILL} ${tone}" data-outcome="${state}">${state}</span>`;

export const renderRevisionPill = (): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<span class="${PILL} bg-warning-soft text-warning" data-revision-pill>revision</span>`;

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
  html`<a href="${cohortHref(hash)}" class="${LINK}">${cohortLabel(fingerprint, hash)}</a>`;

const MARKDOWN = [
  'prose prose-sm max-w-none break-words',
  '[--tw-prose-body:var(--color-fg)] [--tw-prose-headings:var(--color-fg)] [--tw-prose-bold:var(--color-fg)]',
  '[--tw-prose-code:var(--color-fg)] [--tw-prose-pre-code:var(--color-fg)] [--tw-prose-quotes:var(--color-fg)]',
  '[--tw-prose-lead:var(--color-muted)] [--tw-prose-counters:var(--color-muted)] [--tw-prose-bullets:var(--color-muted)] [--tw-prose-captions:var(--color-muted)]',
  '[--tw-prose-hr:var(--color-line)] [--tw-prose-quote-borders:var(--color-line)] [--tw-prose-th-borders:var(--color-line)] [--tw-prose-td-borders:var(--color-line)]',
  '[--tw-prose-links:var(--color-accent-text)] [--tw-prose-pre-bg:var(--color-raised)]',
  'prose-pre:overflow-x-auto prose-table:my-0 [&>div]:my-6 [&>:first-child]:mt-0 [&>:last-child]:mb-0',
  '[&>:is(p,ul,ol,blockquote,h1,h2,h3,h4,h5,h6)]:max-w-[80ch]',
  'prose-th:min-w-32 prose-td:min-w-32',
  'prose-code:before:content-none prose-code:after:content-none',
  '[&_blockquote_p]:before:content-none [&_blockquote_p]:after:content-none',
].join(' ');

export const renderMarkdownBody = (text: string): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<div class="${MARKDOWN}" data-markdown>${raw(renderMarkdown(text))}</div>`;

export const renderReasonBlock = ({ label, detail, tone }: RunReason): Rendered => {
  const named = label === null ? '' : html`<span class="font-semibold">${label}</span>`;
  if (detail === null) {
    return html`<div class="mb-4 rounded-lg px-4 py-2.5 ${tone}" data-reason><span data-reason-summary>${named}</span></div>`;
  }
  const line = firstLine(detail);
  return html`<details class="group mb-4 rounded-lg ${tone}" data-reason>
    <summary data-reason-summary class="block cursor-pointer truncate px-4 py-2.5 before:mr-2.5 before:inline-block before:w-3 before:text-center before:text-[0.65rem] before:transition-transform before:content-['▶'] group-open:before:rotate-90">${named}${label === null ? line : html`<span class="group-open:hidden">: ${line}</span>`}</summary>
    <div class="px-4 pb-3 pl-[2.375rem]">${renderMarkdownBody(detail)}</div>
  </details>`;
};

export const SUMMARY_FIGURE = 'text-[0.9rem] tabular-nums text-muted';

const TILE_LABEL = 'm-0 text-xs font-semibold uppercase tracking-[0.05em] text-muted';

export const renderTile = (name: string, label: string, value: Rendered, note: Rendered = ''): Rendered =>
  html`<div class="flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-surface px-4 py-3" data-tile="${name}">
      <span class="${TILE_LABEL}">${label}</span>
      <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1 break-words text-[1.15rem] font-semibold tabular-nums [&_[data-badge]]:ml-0" data-tile-value>${value}</div>
      ${note === '' ? '' : html`<span class="${SUMMARY_FIGURE} break-words">${note}</span>`}
    </div>`;
