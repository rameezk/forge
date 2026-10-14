import { html, raw } from 'hono/html';
import { isGithubUrl, type RunFingerprint, type GenerationKind, type GenerationRecord, type HarnessEvent, type PullRequestRecord, type RunCounters, type RunRecord, type RunSkillLoad, type SkillCoverage, type RunTicket, type Ticket } from '@forge/shared';
import type { HtmlEscapedString } from 'hono/utils/html';
import { formatBudget, formatCost, formatSpan, formatSpend, formatTime, formatTokens } from '../format.ts';
import { cacheMisses, isCall, promptTokens } from '../calls.ts';
import { summarizeSkillLoads, type SkillSummary } from '../skills.ts';
import type { CallEfforts, RequestRecordView, ToolDefinition, WorkloadContext } from '../request-record.ts';
import { CALLOUT, type Rendered, NOT_RECORDED, PARTIAL_BADGE, PENDING, BADGE, SUBSCRIPTION_BADGE, ESTIMATED_BADGE, ROW, TD, NUMERIC, NUMERIC_WRAPPING, SECTION_TITLE, CARD, TABLE, TH, type Cost, configuredEffort, BLOCK, DISCLOSURE, LABEL, PROSE, STACK, INLINE_DISCLOSURE, CODE, externalLink, PILL, PULL_REQUEST_TONE, LINK, renderRunTicket, renderAttemptsLink, renderCohortLink, SHORT_SHA_LENGTH, type AssetHrefs, PAGE_TITLE, renderStatus, renderTimestamp, renderDuration, renderRunCost, renderTokens, renderCacheHitRate, ERROR_CALLOUT, EMPTY, layout } from './shared.ts';
import { renderTranscript } from './transcript.ts';

export const isSettled = (run: Pick<RunRecord, 'endTime' | 'costStatus'>): boolean =>
  run.endTime !== null && run.costStatus !== 'pending';

const WARNING_CALLOUT = `${CALLOUT} bg-warning-soft text-warning`;

const renderClock = (iso: string): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<time datetime="${iso}" title="${iso}">${formatTime(iso)}</time>`;

const renderCache = (run: RunRecord): Rendered =>
  run.cacheReadTokens === null || run.cacheWriteTokens === null
    ? NOT_RECORDED
    : html`${formatTokens(run.cacheReadTokens)} read / ${formatTokens(run.cacheWriteTokens)} write`;

const renderListPriceEquivalent = (
  run: RunRecord,
  generations: GenerationRecord[],
): Rendered => {
  if (run.costStatus !== 'subscription') return '';
  const priced = generations.flatMap(({ listPriceEquivalentUsd }) =>
    listPriceEquivalentUsd === null ? [] : [listPriceEquivalentUsd],
  );
  if (priced.length === 0) return '';
  const total = priced.reduce((sum, usd) => sum + usd, 0);
  return html`<dt class="${META_TERM}" title="What this workload would have cost at the model's list price. Not billed.">List-price equivalent</dt>
      <dd class="${META_VALUE}" data-list-price-equivalent>${formatCost(total)}${priced.length < generations.length ? html`<wbr>${PARTIAL_BADGE}` : ''}</dd>`;
};

const renderProviders = (run: RunRecord, generations: GenerationRecord[]): Rendered => {
  if (run.costStatus === 'subscription') return html`anthropic`;
  const providers = [
    ...new Set(generations.flatMap(({ provider }) => (provider === null ? [] : [provider]))),
  ];
  if (providers.length > 0) {
    return html`${providers.join(', ')}`;
  }
  const settling =
    run.costStatus === 'pending' ||
    generations.some(({ billedCostUsd, givenUpAt }) => billedCostUsd === null && givenUpAt === null);
  return settling ? html`<span class="${PENDING}">pending</span>` : NOT_RECORDED;
};

const BILLED_BADGE = html`<span class="${BADGE} ml-1.5 bg-line text-fg" data-badge="billed" title="The cost OpenRouter billed for this generation">billed</span>`;

const callCost = (
  { billedCostUsd, estimatedCostUsd, listPriceEquivalentUsd }: GenerationRecord,
  subscription: boolean,
): Rendered => {
  if (subscription) {
    return listPriceEquivalentUsd === null
      ? SUBSCRIPTION_BADGE
      : html`<span title="What this generation would have cost at the model's list price. Not billed.">${formatCost(listPriceEquivalentUsd)}</span>`;
  }
  if (billedCostUsd !== null) return html`${formatCost(billedCostUsd)}<wbr>${BILLED_BADGE}`;
  if (estimatedCostUsd !== null) return html`${formatCost(estimatedCostUsd)}<wbr>${ESTIMATED_BADGE}`;
  return html`<span class="${PENDING}">pending</span>`;
};

const optionalTokens = (count: number | null): string => (count === null ? '' : formatTokens(count));

const CACHE_MISS_BADGE = html`<span class="${BADGE} mr-1.5 bg-warning-soft text-warning" data-badge="cache-miss" title="This call's cache read fell well below the previous call's prompt size, so most of its prompt was not served from the cache">miss</span>`;

const KIND_BADGES: Record<Exclude<GenerationKind, 'message'>, Rendered> = {
  compaction: html`<span class="${BADGE} bg-line text-fg" data-badge="compaction" title="The summary model call behind a context compaction">compaction</span>`,
  cache_warm: html`<span class="${BADGE} bg-line text-fg" data-badge="cache-warm" title="A request that kept the prompt cache warm">cache warm</span>`,
};

const kindBadge = ({ kind }: GenerationRecord): Rendered =>
  kind === 'message' ? '' : html`<wbr><div>${KIND_BADGES[kind]}</div>`;

const renderCall = (
  generation: GenerationRecord,
  miss: boolean,
  effort: string | undefined,
  subscription: boolean,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const { usage } = generation;
  return html`<tr class="${miss ? 'bg-warning-soft' : ROW}" data-call${miss ? html` data-cache-miss` : ''}>
    <td class="${TD} whitespace-nowrap" data-time>${renderClock(generation.createdAt)}${kindBadge(generation)}</td>
    <td class="${TD} whitespace-nowrap" data-provider>${generation.provider ?? ''}</td>
    <td class="${TD} wrap-anywhere" data-served-model>${generation.servedModel ?? ''}</td>
    <td class="${TD} whitespace-nowrap" data-effort>${effort ?? ''}</td>
    <td class="${TD} ${NUMERIC}" data-prompt>${usage === null ? '' : formatTokens(promptTokens(usage))}</td>
    <td class="${TD} ${NUMERIC}" data-cache-read>${miss ? CACHE_MISS_BADGE : ''}${usage === null ? '' : formatTokens(usage.cacheReadTokens)}</td>
    <td class="${TD} ${NUMERIC}" data-cache-write>${usage === null ? '' : formatTokens(usage.cacheWriteTokens)}</td>
    <td class="${TD} ${NUMERIC}" data-output>${usage === null ? '' : formatTokens(usage.outputTokens)}</td>
    <td class="${TD} ${NUMERIC}" data-reasoning>${optionalTokens(generation.reasoningTokens)}</td>
    <td class="${TD} ${NUMERIC_WRAPPING}" data-cost>${callCost(generation, subscription)}</td>
  </tr>`;
};

const sentEfforts = (calls: GenerationRecord[], efforts: CallEfforts): (string | undefined)[] => {
  const seen = new Map<string | null, number>();
  return calls.map(({ subagent }) => {
    const index = seen.get(subagent) ?? 0;
    seen.set(subagent, index + 1);
    return efforts.get(subagent)?.[index];
  });
};

const renderCalls = (
  calls: GenerationRecord[],
  efforts: (string | undefined)[],
  subscription: boolean,
): Rendered => {
  if (calls.length === 0) return '';
  const misses = cacheMisses(calls);
  return html`<h2 class="${SECTION_TITLE} mt-8 mb-3">Calls</h2>
    <div class="${CARD}" data-calls>
      <table class="${TABLE}">
        <thead>
          <tr>
            <th class="${TH}">Time</th>
            <th class="${TH}">Provider</th>
            <th class="${TH}">Served model</th>
            <th class="${TH}">Effort</th>
            <th class="${TH} text-right">Prompt</th>
            <th class="${TH} text-right">Cache read</th>
            <th class="${TH} text-right">Cache write</th>
            <th class="${TH} text-right">Output</th>
            <th class="${TH} text-right">Reasoning</th>
            <th class="${TH} text-right">${subscription ? 'List price' : 'Cost'}</th>
          </tr>
        </thead>
        <tbody>${calls.map((call, index) => renderCall(call, misses.has(call), efforts[index], subscription))}</tbody>
      </table>
    </div>`;
};

const summaryEffort = (run: Pick<RunRecord, 'reasoningEffort'>, sent: (string | undefined)[]): string =>
  sent.some((effort) => effort !== undefined && effort !== configuredEffort(run))
    ? 'varied'
    : configuredEffort(run);

const renderExceeded = (run: RunRecord): Rendered => {
  if (run.status !== 'exceeded' || run.endTime === null) return '';
  if (run.exceededLimit === 'budget' && run.maxCostUsd !== null) {
    return html`<p class="${WARNING_CALLOUT} mb-4" data-exceeded>Stopped at ${formatSpend(run.costUsd)} of a ${formatBudget(run.maxCostUsd)} budget</p>`;
  }
  if (run.exceededLimit === 'timeout' && run.timeoutSeconds !== null) {
    const stoppedAfter = (Date.parse(run.endTime) - Date.parse(run.harnessStartTime ?? run.startTime)) / 1000;
    return html`<p class="${WARNING_CALLOUT} mb-4" data-exceeded>Stopped after ${formatSpan(stoppedAfter)} of a ${formatSpan(run.timeoutSeconds)} timeout</p>`;
  }
  return '';
};

const NEW_ACTIVITY = 'fixed bottom-6 left-1/2 z-10 -translate-x-1/2 cursor-pointer rounded-full border border-line bg-surface px-4 py-1.5 text-sm font-semibold text-fg shadow-md hover:bg-raised';

const META_TERM = 'text-muted';

const META_VALUE = 'm-0 min-w-0 break-words tabular-nums';

export interface Downloads {
  transcript: boolean;
  rawEvents: boolean;
  requestRecord: boolean;
}

const DOWNLOADS: { key: keyof Downloads; path: string; label: string }[] = [
  { key: 'transcript', path: 'transcript.jsonl', label: 'Transcript' },
  { key: 'rawEvents', path: 'raw-events', label: 'Raw events' },
  { key: 'requestRecord', path: 'request-record', label: 'Request record' },
];

const CONTEXT_BODY = 'rounded-b-[7px] border-t border-line bg-bg p-4 pt-3';

const renderSystemPrompt = (systemPrompt: string | null): Rendered =>
  systemPrompt === null
    ? ''
    : html`<details class="${BLOCK} border-line" data-system-prompt>
        <summary class="${DISCLOSURE}"><span class="${LABEL}">System prompt</span></summary>
        <div class="${CONTEXT_BODY}"><pre class="${PROSE} text-[0.9rem]">${systemPrompt}</pre></div>
      </details>`;

const renderToolDefinition = ({ name, description, parameters }: ToolDefinition): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<li class="${STACK} gap-1.5 border-t border-line pt-3 first:border-t-0 first:pt-0" data-tool>
    <code class="font-mono text-[0.85rem] font-semibold" data-tool-name>${name}</code>
    ${description === '' ? '' : html`<pre class="${PROSE} text-[0.9rem]">${description}</pre>`}
    ${parameters === null
      ? ''
      : html`<details>
          <summary class="${INLINE_DISCLOSURE} inline-flex font-semibold">Parameters</summary>
          <pre class="${CODE} mt-1.5">${JSON.stringify(parameters, null, 2)}</pre>
        </details>`}
  </li>`;

const renderTools = (tools: ToolDefinition[] | null): Rendered =>
  tools === null
    ? ''
    : html`<details class="${BLOCK} border-line" data-tools>
        <summary class="${DISCLOSURE}"><span class="${LABEL}">Tools</span><span class="text-xs tabular-nums text-muted" data-tool-count>${tools.length}</span></summary>
        <ul class="m-0 ${STACK} list-none ${CONTEXT_BODY}">${tools.map(renderToolDefinition)}</ul>
      </details>`;

const renderContext = ({ systemPrompt, tools }: WorkloadContext): Rendered =>
  systemPrompt === null && tools === null
    ? ''
    : html`<div class="${STACK} mb-4" data-context>${renderSystemPrompt(systemPrompt)}${renderTools(tools)}</div>`;

const renderPullRequest = (pullRequest: PullRequestRecord | null): Rendered =>
  pullRequest === null
    ? ''
    : html`<dt class="${META_TERM}">Pull request</dt>
      <dd class="${META_VALUE} flex flex-wrap items-baseline gap-x-3 gap-y-1" data-pull-request>${isGithubUrl(pullRequest.url)
        ? externalLink(pullRequest.url, `#${pullRequest.number}`)
        : html`#${pullRequest.number}`}<span class="${PILL} ${PULL_REQUEST_TONE[pullRequest.state]}" data-pull-request-state="${pullRequest.state}">${pullRequest.state}</span>${pullRequest.rework === null
        ? ''
        : html`<span>rework ${pullRequest.rework}</span>`}</dd>`;

const skillWhere = ({ prompt, parent, subagents }: SkillSummary): string =>
  [
    ...(prompt ? ['prompt'] : []),
    ...(parent ? ['parent'] : []),
    ...(subagents === 0 ? [] : [`${subagents} ${subagents === 1 ? 'subagent' : 'subagents'}`]),
  ].join(', ');

const renderPartialCoverage = ({ coveredLines, totalLines }: SkillCoverage): Rendered =>
  html`<span class="rounded bg-warning-soft px-1.5 py-0.5 text-xs font-semibold text-warning" data-skill-partial title="This load read ${coveredLines} of the skill file's ${totalLines} lines">partial · ${coveredLines}/${totalLines}</span>`;

const renderSkills = (loads: RunSkillLoad[]): Rendered => {
  const skills = summarizeSkillLoads(loads);
  if (skills.length === 0) return '';
  return html`<dt class="${META_TERM}">Skills</dt>
      <dd class="${META_VALUE}"><ul class="m-0 flex list-none flex-col gap-1 p-0" data-skills>${skills.map(
        (summary) =>
          html`<li class="flex flex-wrap items-baseline gap-x-3" data-skill="${summary.skill}"><code class="font-mono text-[0.85rem] font-semibold">${summary.skill}</code><span class="text-muted" data-skill-where>${skillWhere(summary)}</span>${summary.partial.map(renderPartialCoverage)}</li>`,
      )}</ul></dd>`;
};

const renderDownloads = (run: RunRecord, downloads: Downloads): Rendered => {
  const offered = DOWNLOADS.filter(({ key }) => downloads[key]);
  if (offered.length === 0) return '';
  return html`<dt class="${META_TERM}">Downloads</dt>
      <dd class="${META_VALUE} flex flex-wrap gap-x-4 gap-y-1">${offered.map(
        ({ path, label }) =>
          html`<a href="/runs/${encodeURIComponent(run.id)}/${path}" download class="${LINK}" data-download="${path}">${label}</a>`,
      )}</dd>`;
};

const COUNTER_ROWS = [
  { key: 'toolCalls', label: 'Tool calls', attribute: 'data-tool-calls' },
  { key: 'failedToolResults', label: 'Failed tool results', attribute: 'data-failed-tool-results' },
  { key: 'retries', label: 'Retries', attribute: 'data-retries' },
  { key: 'compactions', label: 'Compactions', attribute: 'data-compactions' },
] as const;

const renderCounters = (counters: RunCounters | null): Rendered =>
  counters === null
    ? ''
    : html`${COUNTER_ROWS.map(
        ({ key, label, attribute }) =>
          html`<dt class="${META_TERM}">${label}</dt>
      <dd class="${META_VALUE}" ${raw(attribute)}>${counters[key]}</dd>`,
      )}`;

const renderTicketRow = (ticket: RunTicket | null): Rendered =>
  ticket === null
    ? ''
    : html`<dt class="${META_TERM}">Ticket</dt>
      <dd class="${META_VALUE} flex flex-wrap items-baseline gap-x-3 gap-y-1">${renderRunTicket(ticket)}${renderAttemptsLink(ticket, 'All attempts')}</dd>`;

const renderConfig = (config: RunFingerprint | null): Rendered =>
  html`<dt class="${META_TERM}">Config</dt>
    <dd class="${META_VALUE}" data-cohort>${renderCohortLink(config?.hash ?? null, config?.fingerprint ?? null)}</dd>
    ${config === null
      ? ''
      : html`<dt class="${META_TERM}">Forge</dt>
        <dd class="${META_VALUE} tabular-nums" data-forge-sha>${config.forgeGitSha === null
          ? html`<span class="text-muted">unknown</span>`
          : html`<span title="${config.forgeGitSha}">${config.forgeGitSha.slice(0, SHORT_SHA_LENGTH)}</span>`}</dd>`}`;

export const renderDetail = (
  run: RunRecord,
  events: HarnessEvent[],
  { context, efforts: recordedEfforts }: RequestRecordView,
  generations: GenerationRecord[],
  pullRequest: PullRequestRecord | null,
  skillLoads: RunSkillLoad[],
  downloads: Downloads,
  config: RunFingerprint | null,
  assets: AssetHrefs,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const live = !isSettled(run);
  const stopped = renderExceeded(run);
  const calls = generations.filter(isCall);
  const efforts = sentEfforts(calls, recordedEfforts);
  const body = html`<p class="m-0 mb-4 text-[0.9rem]"><a href="/" class="${LINK}">&larr; Workloads</a></p>
    <h1 class="${PAGE_TITLE} break-words">${run.worker}</h1>
    <dl class="m-0 mb-4 grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-6 gap-y-2 rounded-lg border border-line bg-surface px-4 py-3 text-[0.9rem]">
      <dt class="${META_TERM}">Harness</dt>
      <dd class="${META_VALUE}" data-harness>${run.harness}</dd>
      <dt class="${META_TERM}">Model</dt>
      <dd class="${META_VALUE}">${run.model}</dd>
      <dt class="${META_TERM}">Reasoning effort</dt>
      <dd class="${META_VALUE}">${summaryEffort(run, efforts)}</dd>
      ${renderConfig(config)}
      <dt class="${META_TERM}">Status</dt>
      <dd class="${META_VALUE}">${renderStatus(run.status)}</dd>
      <dt class="${META_TERM}">Started</dt>
      <dd class="${META_VALUE}">${renderTimestamp(run.startTime)}</dd>
      <dt class="${META_TERM}">Duration</dt>
      <dd class="${META_VALUE}" data-duration>${renderDuration(run)}</dd>
      <dt class="${META_TERM}">Cost</dt>
      <dd class="${META_VALUE}">${renderRunCost(run)}</dd>
      ${renderListPriceEquivalent(run, generations)}
      <dt class="${META_TERM}">Tokens</dt>
      <dd class="${META_VALUE}">${renderTokens(run)}</dd>
      <dt class="${META_TERM}">Cache</dt>
      <dd class="${META_VALUE}">${renderCache(run)}</dd>
      <dt class="${META_TERM}">Cache hit rate</dt>
      <dd class="${META_VALUE}">${renderCacheHitRate(run)}</dd>
      <dt class="${META_TERM}">Providers</dt>
      <dd class="${META_VALUE}">${renderProviders(run, generations)}</dd>
      ${renderCounters(run.counters)}
      ${renderSkills(skillLoads)}
      ${renderPullRequest(pullRequest)}
      ${renderTicketRow(run.ticket)}
      ${renderDownloads(run, downloads)}
    </dl>
    ${stopped !== '' ? stopped : run.error === null ? '' : html`<p class="${run.status === 'interrupted' || run.status === 'exceeded' ? WARNING_CALLOUT : ERROR_CALLOUT} mb-4">${run.error}</p>`}
    ${renderContext(context)}
    ${renderCalls(calls, efforts, run.costStatus === 'subscription')}
    <div class="mt-8 mb-3 flex items-baseline gap-4">
      <h2 class="${SECTION_TITLE}">Transcript</h2>
      ${events.length === 0 ? '' : html`<a href="/runs/${encodeURIComponent(run.id)}/transcript" data-full-transcript class="${LINK} text-[0.9rem]">Full transcript</a>`}
    </div>
    ${events.length === 0
      ? html`<p class="${EMPTY}">No transcript captured.</p>`
      : html`<div class="${STACK}" data-transcript="${events.length}">${renderTranscript(events, generations, run.status, run.costStatus === 'subscription', skillLoads)}</div>`}
    ${live ? html`<button type="button" id="new-activity" hidden class="${NEW_ACTIVITY}">↓ New activity</button>` : ''}`;
  return layout(run.worker, null, live, assets, body);
};
