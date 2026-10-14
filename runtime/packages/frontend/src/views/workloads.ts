import { html } from 'hono/html';
import { isGithubUrl, type ListPriceEquivalent, type RunRecord, type RevisionRecord, type Ticket } from '@forge/shared';
import type { HtmlEscapedString } from 'hono/utils/html';
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

const renderTotal = (runs: RunRecord[]): Rendered => {
  const pending = pendingCount(runs);
  return html`${formatTotal(totalCost(runs))}${pending === 0
    ? ''
    : html` <span class="${PENDING}">+${pending} pending</span>`}`;
};

const renderListPriceTotal = (
  runs: RunRecord[],
  equivalents: Map<string, ListPriceEquivalent>,
): Rendered => {
  const priced = runs.flatMap((run) => {
    const equivalent = isSubscription(run) ? equivalents.get(run.id) : undefined;
    return equivalent === undefined ? [] : [equivalent];
  });
  if (priced.length === 0) return '';
  const total = priced.reduce((sum, { usd }) => sum + usd, 0);
  const partial = priced.length < runs.filter(isSubscription).length || priced.some((equivalent) => equivalent.partial);
  return html`<tr data-total="list-price-equivalent">
    <td colspan="8" class="${TD} text-muted" title="What the subscription workloads would have cost at the models' list price. Not billed.">List-price equivalent, not billed</td>
    <td class="${TD} ${NUMERIC} text-muted">${formatTotal(total)}${partial ? html`<wbr>${PARTIAL_BADGE}` : ''}</td>
  </tr>`;
};

export const renderList = (
  runs: RunRecord[],
  equivalents: Map<string, ListPriceEquivalent>,
  revisions: ReadonlyMap<string, RevisionRecord>,
  assets: AssetHrefs,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const body =
    runs.length === 0
      ? html`<h1 class="${PAGE_TITLE}">Workloads</h1>
          <p class="${EMPTY}">No workloads have run yet.</p>`
      : html`<h1 class="${PAGE_TITLE}">Workloads</h1>
          <div class="${CARD}">
            <table class="${TABLE}">
              <thead>
                <tr>
                  <th class="${TH}">Worker</th>
                  <th class="${TH}">Ticket / PR</th>
                  <th class="${TH}">Model</th>
                  <th class="${TH}">Effort</th>
                  <th class="${TH}">Started</th>
                  <th class="${TH}">Duration</th>
                  <th class="${TH}">Status</th>
                  <th class="${TH} text-right">Cache hit</th>
                  <th class="${TH} text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                ${runs.map(
                  (run) => html`<tr class="${ROW}" data-run="${run.id}">
                    <td class="${TD} whitespace-nowrap"><a href="/runs/${run.id}" class="${LINK}">${run.worker}</a></td>
                    <td class="${TD} whitespace-nowrap tabular-nums" data-run-ticket>${renderRunTicket(run.ticket)}${renderRunPullRequest(revisions.get(run.id))}</td>
                    <td class="${TD} wrap-anywhere text-muted">${run.model}</td>
                    <td class="${TD} whitespace-nowrap" data-effort>${configuredEffort(run)}</td>
                    <td class="${TD}">${renderTimestamp(run.startTime)}</td>
                    <td class="${TD} whitespace-nowrap" data-duration>${renderDuration(run)}</td>
                    <td class="${TD}">${renderStatus(run.status)}</td>
                    <td class="${TD} ${NUMERIC}" data-cache-hit>${renderCacheHitRate(run)}</td>
                    <td class="${TD} ${NUMERIC_WRAPPING}" data-cost>${renderListCost(run, equivalents)}</td>
                  </tr>`,
                )}
              </tbody>
              <tfoot>
                <tr data-total="billed">
                  <td colspan="8" class="${TD} font-semibold">Total</td>
                  <td class="${TD} ${NUMERIC} font-semibold">${renderTotal(runs)}</td>
                </tr>
                ${renderListPriceTotal(runs, equivalents)}
              </tfoot>
            </table>
          </div>`;
  return layout('Workloads', 'runs', true, assets, body);
};
