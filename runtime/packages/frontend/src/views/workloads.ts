import { html } from 'hono/html';
import { isGithubUrl, type ListPriceEquivalent, type RunRecord, type RunStatus, type RevisionRecord } from '@forge/shared';
import type { HtmlEscapedString } from 'hono/utils/html';
import { filterWorkloads, isFiltered, STATUSES, workloadsHref, type WorkloadFilter } from '../workload-filter.ts';
import { formatCost, formatTotal, isSubscription, pendingCount, totalCost } from '../format.ts';
import { type Rendered, externalLink, renderRunCost, SUBSCRIPTION_BADGE, PARTIAL_BADGE, PENDING, TD, NUMERIC, type AssetHrefs, PAGE_TITLE, EMPTY, CARD, TABLE, TH, type Cost, ROW, LINK, renderRunTicket, configuredEffort, renderTimestamp, renderDuration, renderStatus, renderCacheHitRate, NUMERIC_WRAPPING, layout } from './shared.ts';

const renderRunPullRequest = (revision: RevisionRecord | undefined): Rendered =>
  revision === undefined
    ? ''
    : html`<span class="text-muted">${revision.repository}</span> ${isGithubUrl(revision.url)
    ? externalLink(revision.url, `PR #${revision.number}`)
    : html`PR #${revision.number}`}`;

const renderListCost = (run: RunRecord, equivalents: Map<string, ListPriceEquivalent>): Rendered => {
  const equivalent = equivalents.get(run.id);
  if (!isSubscription(run) || equivalent === undefined) return renderRunCost(run);
  return html`${SUBSCRIPTION_BADGE}<wbr><span class="ml-1.5 whitespace-nowrap text-muted" data-list-price-equivalent title="What this workload would have cost at the model's list price. Not billed.">${formatCost(equivalent.usd)} list price</span>${equivalent.partial ? html`<wbr>${PARTIAL_BADGE}` : ''}`;
};

const renderBilledTotal = (runs: RunRecord[], all: RunRecord[]): Rendered => {
  const pending = pendingCount(runs);
  return html`${formatTotal(totalCost(runs))} of ${formatTotal(totalCost(all))} billed${pending === 0
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

const CHIP = 'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[0.85rem] font-medium text-fg no-underline hover:bg-raised';

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

const renderChips = (all: RunRecord[], filter: WorkloadFilter): Rendered => {
  const scoped = filterWorkloads(all, filter, true);
  const chips: { key: string; label: string; status: RunStatus | undefined; count: number }[] = [
    { key: 'all', label: 'All', status: undefined, count: scoped.length },
    ...STATUSES.map((status) => ({
      key: status,
      label: status[0]!.toUpperCase() + status.slice(1),
      status,
      count: scoped.filter((run) => run.status === status).length,
    })),
  ];
  return html`<nav class="mb-3 flex flex-wrap gap-2" aria-label="Status" data-status-chips>
    ${chips.map(({ key, label, status, count }) => {
      const { status: _current, ...rest } = filter;
      const current = filter.status === status;
      return html`<a href="${workloadsHref(status === undefined ? rest : { ...rest, status })}" class="${CHIP} ${current ? CHIP_CURRENT : CHIP_IDLE}" data-status-chip="${key}"${current ? html` aria-current="true"` : ''}>${label} <span class="tabular-nums text-muted">${count}</span></a>`;
    })}
  </nav>`;
};

const renderFilters = (all: RunRecord[], filter: WorkloadFilter): Rendered =>
  html`<form method="get" action="/" class="mb-4 flex flex-wrap items-end gap-3" data-filters>
    ${filter.status === undefined ? '' : html`<input type="hidden" name="status" value="${filter.status}" />`}
    <label class="${FIELD}">Search
      <input type="search" name="search" value="${filter.search ?? ''}" placeholder="Worker or ticket number" class="${CONTROL} w-60" />
    </label>
    ${renderSelect('Worker', 'worker', unique(all.map((run) => run.worker)), filter.worker)}
    ${renderSelect('Repository', 'repository', unique(all.map((run) => run.ticket?.repository)), filter.repository)}
    ${renderSelect('Model', 'model', unique(all.map((run) => run.model)), filter.model)}
    <label class="${FIELD}">Started from
      <input type="date" name="from" value="${filter.from ?? ''}" class="${CONTROL}" />
    </label>
    <label class="${FIELD}">Started to
      <input type="date" name="to" value="${filter.to ?? ''}" class="${CONTROL}" />
    </label>
    <button type="submit" class="h-9 rounded-md border border-line bg-raised px-3 text-[0.9rem] font-semibold text-fg hover:bg-line">Apply</button>
    ${isFiltered(filter) ? html`<a href="/" class="${LINK} py-2 text-[0.9rem]" data-clear-filters>Clear filters</a>` : ''}
  </form>`;

const renderTicketCell = (run: RunRecord, revision: RevisionRecord | undefined): Rendered =>
  run.ticket === null && revision === undefined
    ? html`<span class="text-muted">manual</span>`
    : html`${renderRunTicket(run.ticket)}${renderRunPullRequest(revision)}`;

export const renderList = (
  all: RunRecord[],
  filter: WorkloadFilter,
  equivalents: Map<string, ListPriceEquivalent>,
  revisions: ReadonlyMap<string, RevisionRecord>,
  assets: AssetHrefs,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const runs = filterWorkloads(all, filter);
  const body =
    all.length === 0
      ? html`<h1 class="${PAGE_TITLE}">Workloads</h1>
          <p class="${EMPTY}">No workloads have run yet.</p>`
      : html`<h1 class="${PAGE_TITLE}">Workloads</h1>
          <p class="m-0 mb-4 flex flex-wrap gap-x-3 text-[0.9rem]" data-showing>
            <span>Showing ${runs.length} of ${all.length} workloads, ${renderBilledTotal(runs, all)}</span>
            ${renderListPriceTotal(runs, all, equivalents)}
          </p>
          ${renderChips(all, filter)}
          ${renderFilters(all, filter)}
          ${runs.length === 0
            ? html`<p class="${EMPTY}" data-empty>No workloads match.</p>`
            : html`<div class="${CARD}">
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
                ${runs.map(
                  (run) => html`<tr class="${ROW}" data-run="${run.id}">
                    <td class="${TD}">${renderTimestamp(run.startTime)}</td>
                    <td class="${TD} whitespace-nowrap tabular-nums" data-run-ticket>${renderTicketCell(run, revisions.get(run.id))}</td>
                    <td class="${TD}">${renderStatus(run.status)}</td>
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
          </div>`}`;
  return layout('Workloads', 'runs', true, assets, body);
};
