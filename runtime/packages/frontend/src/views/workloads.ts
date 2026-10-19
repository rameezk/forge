import { html } from 'hono/html';
import { isGithubUrl, type ListPriceEquivalent, type RunRecord, type RunStatus, type PullRequestWorkloadRecord, type RunPullRequestWorkload, type DispatchRecord } from '@forge/shared';
import type { HtmlEscapedString } from 'hono/utils/html';
import { filterWorkloads, isFiltered, paginate, RANGE_PRESETS, STATUSES, type Page, workloadsHref, type WorkloadFilter } from '../workload-filter.ts';
import { formatCost, formatTotal, isSubscription, pendingCount, totalCost, totalUnconfirmedEstimate } from '../format.ts';
import { type Rendered, type RunOutcome, externalLink, renderRunCost, SUBSCRIPTION_BADGE, PARTIAL_BADGE, PENDING, TD, NUMERIC, type Display, PAGE_TITLE, EMPTY, CARD, TABLE, TH, type Cost, ROW, LINK, renderRunTicket, configuredEffort, renderTimestamp, renderDuration, renderStatus, renderRevisionPill, renderCacheHitRate, runOutcomeOf, renderRunOutcome, NUMERIC_WRAPPING, layout } from './shared.ts';

const renderRunPullRequest = (pullRequestWorkload: PullRequestWorkloadRecord | undefined): Rendered =>
  pullRequestWorkload === undefined
    ? ''
    : html`<span class="text-muted">${pullRequestWorkload.repository}</span> ${isGithubUrl(pullRequestWorkload.url)
    ? externalLink(pullRequestWorkload.url, `PR #${pullRequestWorkload.number}`)
    : html`PR #${pullRequestWorkload.number}`}`;

const runErrorOf = (run: RunRecord, pullRequestWorkload: PullRequestWorkloadRecord | undefined): string | null =>
  pullRequestWorkload?.state === 'error' && pullRequestWorkload.reason === null ? run.error : null;

const renderOutcomeBeside = (outcome: RunOutcome | null): Rendered => (outcome === null ? '' : renderRunOutcome(outcome));

const renderOutcomeDetail = (run: RunRecord, pullRequestWorkload: PullRequestWorkloadRecord | undefined, outcome: RunOutcome | null): Rendered => {
  const error = runErrorOf(run, pullRequestWorkload);
  return html`${outcome === null || outcome.text === null ? '' : html`<div class="mt-1 max-w-xs whitespace-pre-line wrap-anywhere text-[0.85rem] text-muted" data-outcome-text>${outcome.text}</div>`}${error === null ? '' : html`<div class="mt-1 max-w-xs whitespace-pre-line wrap-anywhere text-[0.85rem] text-muted" data-run-error>${error}</div>`}`;
};

const renderStatusCell = (run: RunRecord, pullRequestWorkload: PullRequestWorkloadRecord | undefined, dispatch: DispatchRecord | undefined): Rendered => {
  const outcome = runOutcomeOf(pullRequestWorkload, dispatch);
  return html`<div class="flex flex-wrap items-center gap-1.5">${renderStatus(run.status)}${renderOutcomeBeside(outcome)}</div>${renderOutcomeDetail(run, pullRequestWorkload, outcome)}`;
};

const renderListCost = (run: RunRecord, equivalents: Map<string, ListPriceEquivalent>): Rendered => {
  const equivalent = equivalents.get(run.id);
  if (!isSubscription(run) || equivalent === undefined) return renderRunCost(run);
  return html`${SUBSCRIPTION_BADGE}<wbr><span class="ml-1.5 whitespace-nowrap text-muted" data-list-price-equivalent title="What this workload would have cost at the model's list price. Not billed.">${formatCost(equivalent.usd)} list price</span>${equivalent.partial ? html`<wbr>${PARTIAL_BADGE}` : ''}`;
};

const renderBilledTotal = (runs: RunRecord[], all: RunRecord[]): Rendered => {
  const pending = pendingCount(runs);
  const unconfirmed = totalUnconfirmedEstimate(all);
  return html`${formatTotal(totalCost(runs))} of ${formatTotal(totalCost(all))} billed${unconfirmed === 0
    ? ''
    : html` + <span data-unconfirmed-estimate-total>~${formatTotal(totalUnconfirmedEstimate(runs))} of ~${formatTotal(unconfirmed)} unconfirmed estimate</span>`}${pending === 0
    ? ''
    : html` <span class="${PENDING}">+${pending} pending</span>`}`;
};

const listPriceOf = (
  runs: RunRecord[],
  equivalents: Map<string, ListPriceEquivalent>,
): { total: number; partial: boolean; priced: number } => {
  const priced = runs.flatMap((run) => {
    const equivalent = isSubscription(run) ? equivalents.get(run.id) : undefined;
    return equivalent === undefined ? [] : [equivalent];
  });
  return {
    total: priced.reduce((sum, { usd }) => sum + usd, 0),
    partial: priced.length < runs.filter(isSubscription).length || priced.some((equivalent) => equivalent.partial),
    priced: priced.length,
  };
};

const renderListPriceTotal = (
  runs: RunRecord[],
  all: RunRecord[],
  equivalents: Map<string, ListPriceEquivalent>,
): Rendered => {
  const whole = listPriceOf(all, equivalents);
  if (whole.priced === 0) return '';
  const shown = listPriceOf(runs, equivalents);
  return html`<span class="text-muted" data-total="list-price-equivalent" title="What the subscription workloads would have cost at the models' list price. Not billed.">${formatTotal(shown.total)}${shown.partial ? html`<wbr>${PARTIAL_BADGE}` : ''} of ${formatTotal(whole.total)}${whole.partial ? html`<wbr>${PARTIAL_BADGE}` : ''} list-price equivalent, not billed</span>`;
};

const CONTROL = 'h-9 rounded-md border border-line bg-surface px-2 py-1.5 text-[0.9rem] font-normal normal-case tracking-normal text-fg';

const FIELD = 'flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.05em] text-muted';

const CHIP = 'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-[0.85rem] font-medium text-fg no-underline hover:bg-raised';

const CHIP_CURRENT = 'border-fg bg-raised font-semibold';

const CHIP_IDLE = 'border-line';

const renderOptions = (values: string[], selected: string | undefined): Rendered =>
  html`${values.map((value) => html`<option value="${value}"${value === selected ? html` selected` : ''}>${value}</option>`)}`;

const renderSelect = (label: string, name: string, values: string[], selected: string | undefined): Rendered =>
  html`<label class="${FIELD}">${label}
    <select name="${name}" class="${CONTROL}">
      <option value="">All</option>
      ${renderOptions(values, selected)}
    </select>
  </label>`;

const unique = (values: (string | undefined)[]): string[] =>
  [...new Set(values.filter((value): value is string => value !== undefined))].sort();

const renderChips = (all: RunRecord[], filter: WorkloadFilter, timeZone: string, now: number): Rendered => {
  const scoped = filterWorkloads(all, filter, timeZone, now, true);
  const chips: { key: string; label: string; status: RunStatus | undefined; count: number }[] = [
    { key: 'all', label: 'All', status: undefined, count: scoped.length },
    ...STATUSES.map((status) => ({
      key: status,
      label: status[0]!.toUpperCase() + status.slice(1),
      status,
      count: scoped.filter((run) => run.status === status).length,
    })),
  ];
  return html`<nav class="mb-2 flex gap-2 overflow-x-auto pb-1 sm:mb-3 sm:flex-wrap sm:pb-0" aria-label="Status" data-status-chips>
    ${chips.map(({ key, label, status, count }) => {
      const { status: _current, ...rest } = filter;
      const current = filter.status === status;
      return html`<a href="${workloadsHref(status === undefined ? rest : { ...rest, status })}" class="${CHIP} ${current ? CHIP_CURRENT : CHIP_IDLE}" data-status-chip="${key}"${current ? html` aria-current="true"` : ''}>${label} <span class="tabular-nums text-muted">${count}</span></a>`;
    })}
  </nav>`;
};

const startedRange = ({ range, from, to }: WorkloadFilter): string =>
  RANGE_PRESETS.find(({ key }) => key === range)?.label ?? (from !== undefined && to !== undefined ? `${from} to ${to}` : from !== undefined ? `from ${from}` : to !== undefined ? `to ${to}` : '');

const renderFilters = (all: RunRecord[], filter: WorkloadFilter): Rendered => {
  const range = startedRange(filter);
  const { range: _range, from: _from, to: _to, ...rest } = filter;
  return html`<details class="mb-4 sm:[&:not([open])::details-content]:block sm:[&:not([open])::details-content]:[content-visibility:visible]" data-filters>
  <summary class="flex h-9 cursor-pointer list-none items-center gap-2 rounded-md border border-line bg-surface px-3 text-[0.9rem] font-semibold text-fg sm:hidden [&::-webkit-details-marker]:hidden">Filters${range === '' ? '' : html` <span class="font-normal text-muted" data-started-range>${range}</span>`}</summary>
  <form method="get" action="/workloads" class="mt-3 flex flex-wrap items-end gap-3 sm:mt-0">
    ${filter.status === undefined ? '' : html`<input type="hidden" name="status" value="${filter.status}" />`}
    <label class="${FIELD}">Search
      <input type="search" name="search" value="${filter.search ?? ''}" placeholder="Worker or ticket number" class="${CONTROL} w-60" />
    </label>
    ${renderSelect('Worker', 'worker', unique(all.map((run) => run.worker)), filter.worker)}
    ${renderSelect('Repository', 'repository', unique(all.map((run) => run.ticket?.repository)), filter.repository)}
    ${renderSelect('Model', 'model', unique(all.map((run) => run.model)), filter.model)}
    <div class="flex w-full flex-wrap gap-2" aria-label="Started" data-range-presets>
      ${[{ key: 'any', label: 'Any time', range: undefined }, ...RANGE_PRESETS.map(({ key, label }) => ({ key, label, range: key }))].map(({ key, label, range }) => {
        const current = range === undefined ? filter.range === undefined && filter.from === undefined && filter.to === undefined : filter.range === range;
        return html`<a href="${workloadsHref(range === undefined ? rest : { ...rest, range })}" class="${CHIP} ${current ? CHIP_CURRENT : CHIP_IDLE}" data-range-preset="${key}"${current ? html` aria-current="true"` : ''}>${label}</a>`;
      })}
    </div>
    <label class="${FIELD}">Started from
      <input type="date" name="from" value="${filter.from ?? ''}" class="${CONTROL}" />
    </label>
    <label class="${FIELD}">Started to
      <input type="date" name="to" value="${filter.to ?? ''}" class="${CONTROL}" />
    </label>
    <button type="submit" class="h-9 rounded-md border border-line bg-raised px-3 text-[0.9rem] font-semibold text-fg hover:bg-line">Apply</button>
    ${isFiltered(filter) ? html`<a href="/workloads" class="${LINK} py-2 text-[0.9rem]" data-clear-filters>Clear filters</a>` : ''}
  </form>
  </details>`;
};

const PAGE_LINK = 'rounded-md border px-3 py-1 text-[0.9rem] font-medium no-underline';

const renderPageLink = (direction: 'newer' | 'older', label: string, href: string | undefined): Rendered =>
  href === undefined
    ? html`<span class="${PAGE_LINK} border-line text-muted opacity-60" aria-disabled="true" data-page-link="${direction}">${label}</span>`
    : html`<a href="${href}" class="${PAGE_LINK} border-line text-fg hover:bg-raised" data-page-link="${direction}" rel="${direction === 'newer' ? 'prev' : 'next'}">${label}</a>`;

const renderPager = (paged: Page<RunRecord>, filter: WorkloadFilter): Rendered =>
  html`<nav class="mt-4 flex items-center justify-between gap-3" aria-label="Pages" data-pager>
    ${renderPageLink('newer', 'Newer', paged.hasNewer ? workloadsHref(filter, paged.page - 1) : undefined)}
    <span class="text-[0.9rem] text-muted">Page ${paged.page}</span>
    ${renderPageLink('older', 'Older', paged.hasOlder ? workloadsHref(filter, paged.page + 1) : undefined)}
  </nav>`;

const renderTicketCell = (run: RunRecord, pullRequestWorkload: PullRequestWorkloadRecord | undefined): Rendered =>
  run.ticket === null && pullRequestWorkload === undefined
    ? html`<span class="text-muted">manual</span>`
    : html`${renderRunTicket(run.ticket)}${renderRunPullRequest(pullRequestWorkload)}`;

const STAT_LABEL = 'text-xs font-semibold uppercase tracking-[0.05em] text-muted';

const renderStarted = (iso: string, runWorkload: RunPullRequestWorkload | undefined, timeZone: string): Rendered =>
  runWorkload?.kind === 'revision'
    ? html`<span class="inline-flex items-center gap-2 whitespace-nowrap">${renderTimestamp(iso, timeZone)}${renderRevisionPill()}</span>`
    : renderTimestamp(iso, timeZone);

const renderRunCard = (run: RunRecord, runWorkload: RunPullRequestWorkload | undefined, dispatch: DispatchRecord | undefined, equivalents: Map<string, ListPriceEquivalent>, timeZone: string): Rendered => {
  const pullRequestWorkload = runWorkload?.workload;
  const outcome = runOutcomeOf(pullRequestWorkload, dispatch);
  return html`<article class="relative flex flex-col gap-2 rounded-lg border border-line bg-surface p-3.5 text-[0.9rem]" data-run-card="${run.id}">
    <a href="/runs/${run.id}" class="absolute -inset-px rounded-lg" aria-label="Open ${run.worker} workload" data-card-link></a>
    <div class="flex items-center justify-between gap-3">${renderStarted(run.startTime, runWorkload, timeZone)}<div class="flex flex-wrap items-center justify-end gap-1.5">${renderStatus(run.status)}${renderOutcomeBeside(outcome)}</div></div>
    ${renderOutcomeDetail(run, pullRequestWorkload, outcome)}
    <div class="flex flex-wrap items-baseline justify-between gap-x-3"><span class="relative" data-run-ticket>${renderTicketCell(run, pullRequestWorkload)}</span><span class="font-semibold">${run.worker}</span></div>
    <div class="flex flex-wrap items-baseline justify-between gap-x-3"><span class="wrap-anywhere text-muted">${run.model}</span><span data-effort>${configuredEffort(run)}</span></div>
    <dl class="m-0 grid grid-cols-[auto_auto_minmax(0,1fr)] gap-x-5 gap-y-1 border-t border-line pt-2">
      <div class="flex flex-col gap-0.5"><dt class="${STAT_LABEL}">Duration</dt><dd class="m-0 tabular-nums" data-duration>${renderDuration(run)}</dd></div>
      <div class="flex flex-col gap-0.5"><dt class="${STAT_LABEL}">Cache hit</dt><dd class="m-0 tabular-nums" data-cache-hit>${renderCacheHitRate(run)}</dd></div>
      <div class="flex min-w-0 flex-col gap-0.5 text-right"><dt class="${STAT_LABEL}">Cost</dt><dd class="m-0 tabular-nums" data-cost>${renderListCost(run, equivalents)}</dd></div>
    </dl>
  </article>`;
};

export const renderList = (
  all: RunRecord[],
  filter: WorkloadFilter,
  requestedPage: number,
  equivalents: Map<string, ListPriceEquivalent>,
  pullRequestWorkloads: ReadonlyMap<string, RunPullRequestWorkload>,
  dispatches: ReadonlyMap<string, DispatchRecord>,
  display: Display,
  now: number,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const runs = filterWorkloads(all, filter, display.timeZone, now);
  const paged = paginate(runs, requestedPage);
  const body =
    all.length === 0
      ? html`<h1 class="${PAGE_TITLE}">Workloads</h1>
          <p class="${EMPTY}">No workloads have run yet.</p>`
      : html`<h1 class="${PAGE_TITLE}">Workloads</h1>
          <p class="m-0 mb-4 flex flex-wrap gap-x-3 text-[0.9rem]" data-showing>
            <span>Showing ${runs.length} of ${all.length} workloads, ${renderBilledTotal(runs, all)}</span>
            ${renderListPriceTotal(runs, all, equivalents)}
          </p>
          ${renderChips(all, filter, display.timeZone, now)}
          ${renderFilters(all, filter)}
          ${runs.length === 0
            ? html`<p class="${EMPTY}" data-empty>No workloads match.</p>`
            : html`<div class="flex flex-col gap-3 sm:hidden" data-run-cards>
            ${runs.map((run) => renderRunCard(run, pullRequestWorkloads.get(run.id), dispatches.get(run.id), equivalents, display.timeZone))}
          </div>
          <div class="${CARD} hidden sm:block">
            <table class="${TABLE}">
              <thead>
                <tr>
                  <th class="${TH}">Started</th>
                  <th class="${TH}">Ticket</th>
                  <th class="${TH}">Status</th>
                  <th class="${TH}">Worker</th>
                  <th class="${TH}">Model</th>
                  <th class="${TH}">Effort</th>
                  <th class="${TH}">Duration</th>
                  <th class="${TH} text-right">Cache hit</th>
                  <th class="${TH} text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                ${paged.items.map(
                  (run) => html`<tr class="${ROW}" data-run="${run.id}">
                    <td class="${TD}">${renderStarted(run.startTime, pullRequestWorkloads.get(run.id), display.timeZone)}</td>
                    <td class="${TD} whitespace-nowrap tabular-nums" data-run-ticket>${renderTicketCell(run, pullRequestWorkloads.get(run.id)?.workload)}</td>
                    <td class="${TD}">${renderStatusCell(run, pullRequestWorkloads.get(run.id)?.workload, dispatches.get(run.id))}</td>
                    <td class="${TD} whitespace-nowrap"><a href="/runs/${run.id}" class="${LINK}">${run.worker}</a></td>
                    <td class="${TD} wrap-anywhere text-muted">${run.model}</td>
                    <td class="${TD} whitespace-nowrap" data-effort>${configuredEffort(run)}</td>
                    <td class="${TD} whitespace-nowrap" data-duration>${renderDuration(run)}</td>
                    <td class="${TD} ${NUMERIC}" data-cache-hit>${renderCacheHitRate(run)}</td>
                    <td class="${TD} ${NUMERIC_WRAPPING}" data-cost>${renderListCost(run, equivalents)}</td>
                  </tr>`,
                )}
              </tbody>
            </table>
          </div>
          ${renderPager(paged, filter)}`}`;
  return layout('Workloads', 'workloads', true, display, body);
};
