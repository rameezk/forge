import { html } from 'hono/html';
import { isGithubUrl, type AttemptRevision, type RevisionState, type RunFingerprint, type RunCounters, type TicketAttempt } from '@forge/shared';
import type { HtmlEscapedString } from 'hono/utils/html';
import { formatDuration } from '../format.ts';
import { PULL_REQUEST_TONE, type Rendered, PILL, NOT_RECORDED, SHORT_SHA_LENGTH, ROW, TD, LINK, renderDate, renderCohortLink, NUMERIC, renderRunCost, externalLink, type AssetHrefs, PAGE_TITLE, EMPTY, CARD, TABLE, TH, type Cost, layout } from './shared.ts';

const FAILED_TONE = 'bg-error-soft text-error';

const attemptOutcome = ({ run, pullRequest }: TicketAttempt): [string, string] => {
  if (pullRequest !== null) return [pullRequest.state, PULL_REQUEST_TONE[pullRequest.state]];
  if (run.endTime === null) return ['running', 'bg-raised text-fg'];
  if (run.status === 'interrupted' || run.status === 'exceeded') return [run.status, 'bg-warning-soft text-warning'];
  return ['failed', FAILED_TONE];
};

const renderOutcome = (attempt: TicketAttempt): Rendered => {
  const [label, tone] = attemptOutcome(attempt);
  return html`<span class="${PILL} ${tone}" data-outcome="${label}">${label}</span>`;
};

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

const renderAttemptCounters = (counters: RunCounters | null): Rendered =>
  counters === null
    ? NOT_RECORDED
    : html`<div class="flex flex-wrap gap-x-3 gap-y-0.5">${[
        plural(counters.toolCalls, 'tool call', 'tool calls'),
        `${counters.failedToolResults} failed`,
        plural(counters.retries, 'retry', 'retries'),
        plural(counters.compactions, 'compaction', 'compactions'),
      ].map((item) => html`<span data-counter class="whitespace-nowrap">${item}</span>`)}</div>`;

const renderBaseCommit = (config: RunFingerprint | null): Rendered =>
  config?.baseCommit == null
    ? NOT_RECORDED
    : html`<span title="${config.baseCommit}">${config.baseCommit.slice(0, SHORT_SHA_LENGTH)}</span>`;

const REVISION_TONE: Record<RevisionState, string> = {
  running: 'bg-raised text-fg',
  ok: 'bg-success-soft text-success',
  error: FAILED_TONE,
  exceeded: 'bg-warning-soft text-warning',
  interrupted: 'bg-warning-soft text-warning',
};

const renderRevision = ({ revision, run }: AttemptRevision): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<tr class="${ROW}" data-revision="${run.id}">
    <td class="${TD} whitespace-nowrap pl-8" data-field="run"><span class="text-muted" aria-hidden="true">&crarr; </span><a href="/runs/${encodeURIComponent(run.id)}" class="${LINK}">${renderDate(run.startTime)}</a> <span class="text-muted">revision</span></td>
    <td class="${TD}"></td>
    <td class="${TD}"></td>
    <td class="${TD}" data-field="outcome"><span class="${PILL} ${REVISION_TONE[revision.state]}" data-outcome="${revision.state}">${revision.state}</span></td>
    <td class="${TD} ${NUMERIC}" data-field="cost">${renderRunCost(run)}</td>
    <td class="${TD} ${NUMERIC}" data-field="duration">${formatDuration(run.startTime, run.endTime)}</td>
    <td class="${TD}"></td>
    <td class="${TD}"></td>
  </tr>`;

const renderAttempt = (attempt: TicketAttempt): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const { run, config, pullRequest } = attempt;
  return html`<tr class="${ROW}" data-attempt="${run.id}">
    <td class="${TD} whitespace-nowrap" data-field="run"><a href="/runs/${encodeURIComponent(run.id)}" class="${LINK}">${renderDate(run.startTime)}</a></td>
    <td class="${TD}" data-field="cohort">${renderCohortLink(config?.hash ?? null, config?.fingerprint ?? null)}</td>
    <td class="${TD} whitespace-nowrap tabular-nums" data-field="base-commit">${renderBaseCommit(config)}</td>
    <td class="${TD}" data-field="outcome">${renderOutcome(attempt)}</td>
    <td class="${TD} ${NUMERIC}" data-field="cost">${renderRunCost(run)}</td>
    <td class="${TD} ${NUMERIC}" data-field="duration">${formatDuration(run.startTime, run.endTime)}</td>
    <td class="${TD} min-w-56 tabular-nums" data-field="counters">${renderAttemptCounters(run.counters)}</td>
    <td class="${TD} whitespace-nowrap" data-field="pull-request">${pullRequest === null
      ? ''
      : isGithubUrl(pullRequest.url)
        ? externalLink(pullRequest.url, `#${pullRequest.number}`)
        : html`#${pullRequest.number}`}</td>
  </tr>${attempt.revisions.map(renderRevision)}`;
};

export const renderTicketAttempts = (
  ticket: { repository: string; number: number },
  attempts: TicketAttempt[],
  assets: AssetHrefs,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const body = html`<p class="m-0 mb-4 text-[0.9rem]"><a href="/work" class="${LINK}">&larr; Work</a></p>
    <h1 class="${PAGE_TITLE} break-words">${ticket.repository} #${ticket.number}</h1>
    ${attempts.length === 0
      ? html`<p class="${EMPTY}" data-empty>No attempts have run against this ticket.</p>`
      : html`<div class="${CARD}" data-attempts-table role="region" aria-label="Attempts" tabindex="0">
          <table class="${TABLE}">
            <thead>
              <tr>
                <th class="${TH}">Started</th>
                <th class="${TH}">Cohort</th>
                <th class="${TH}">Base commit</th>
                <th class="${TH}">Outcome</th>
                <th class="${TH} text-right">Cost</th>
                <th class="${TH} text-right">Duration</th>
                <th class="${TH}">Counters</th>
                <th class="${TH}">Pull request</th>
              </tr>
            </thead>
            <tbody>${attempts.map(renderAttempt)}</tbody>
          </table>
        </div>`}`;
  return layout(`${ticket.repository} #${ticket.number}`, null, true, assets, body);
};
