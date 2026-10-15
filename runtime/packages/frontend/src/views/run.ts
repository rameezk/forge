import { html, raw } from 'hono/html';
import { isGithubUrl, type RunFingerprint, type GenerationKind, type GenerationRecord, type HarnessEvent, type PullRequestRecord, type RevisedPullRequest, type RunCounters, type RunRecord, type RunSkillLoad, type SkillCoverage, type Ticket } from '@forge/shared';
import type { HtmlEscapedString } from 'hono/utils/html';
import { cacheHitRate, formatBudget, formatCost, formatSpan, formatSpend, formatTime, formatTokens } from '../format.ts';
import { cacheMisses, isCall, promptTokens } from '../calls.ts';
import { summarizeSkillLoads, type SkillSummary } from '../skills.ts';
import type { CallEfforts, RequestRecordView, ToolDefinition, WorkloadContext } from '../request-record.ts';
import { CALLOUT, type Rendered, NOT_RECORDED, PARTIAL_BADGE, PENDING, BADGE, SUBSCRIPTION_BADGE, ESTIMATED_BADGE, ROW, TD, NUMERIC, NUMERIC_WRAPPING, SECTION_TITLE, CARD, TABLE, TH, type Cost, configuredEffort, BLOCK, DISCLOSURE, LABEL, PROSE, STACK, INLINE_DISCLOSURE, CODE, externalLink, PILL, PULL_REQUEST_TONE, LINK, renderRunTicket, renderAttemptsLink, renderCohortLink, SHORT_SHA_LENGTH, type AssetHrefs, PAGE_TITLE, renderStatus, renderTimestamp, renderDuration, renderRunCost, renderCacheHitRate, layout } from './shared.ts';
import { renderWidget } from './widget.ts';

export const isSettled = (run: Pick<RunRecord, 'endTime' | 'costStatus'>): boolean =>
  run.endTime !== null && run.costStatus !== 'pending';

const WARNING_CALLOUT = `${CALLOUT} bg-warning-soft text-warning`;

const renderClock = (iso: string): HtmlEscapedString | Promise<HtmlEscapedString> =>
  html`<time datetime="${iso}" title="${iso}">${formatTime(iso)}</time>`;

const renderCache = (run: RunRecord): Rendered =>
  run.cacheReadTokens === null || run.cacheWriteTokens === null
    ? NOT_RECORDED
    : html`${formatTokens(run.cacheReadTokens)} read / ${formatTokens(run.cacheWriteTokens)} write`;

const renderListPriceTotal = (run: RunRecord, generations: GenerationRecord[]): Rendered => {
  if (run.costStatus !== 'subscription') return '';
  const priced = generations.flatMap(({ listPriceEquivalentUsd }) =>
    listPriceEquivalentUsd === null ? [] : [listPriceEquivalentUsd],
  );
  if (priced.length === 0) return '';
  const total = priced.reduce((sum, usd) => sum + usd, 0);
  return html`<span data-list-price-equivalent title="What this workload would have cost at the model's list price. Not billed.">${formatCost(total)} list price${priced.length < generations.length ? html`<wbr>${PARTIAL_BADGE}` : ''}</span>`;
};

const renderListPriceEquivalent = (run: RunRecord, generations: GenerationRecord[]): Rendered => {
  const total = renderListPriceTotal(run, generations);
  return total === ''
    ? ''
    : html`<dt class="${META_TERM}">List-price equivalent</dt>
      <dd class="${META_VALUE}">${total}</dd>`;
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

const callCostUsd = (
  { billedCostUsd, estimatedCostUsd, listPriceEquivalentUsd }: GenerationRecord,
  subscription: boolean,
): number => (subscription ? listPriceEquivalentUsd : (billedCostUsd ?? estimatedCostUsd)) ?? 0;

const renderCallsSummary = (calls: GenerationRecord[], misses: number, subscription: boolean): Rendered => {
  const measured = calls.flatMap(({ usage }) => (usage === null ? [] : [usage]));
  const rate = cacheHitRate({
    inputTokens: measured.reduce((sum, { inputTokens }) => sum + inputTokens, 0),
    cacheReadTokens: measured.reduce((sum, { cacheReadTokens }) => sum + cacheReadTokens, 0),
    cacheWriteTokens: measured.reduce((sum, { cacheWriteTokens }) => sum + cacheWriteTokens, 0),
  });
  const total = calls.reduce((sum, call) => sum + callCostUsd(call, subscription), 0);
  return html`<summary class="${DISCLOSURE} flex-wrap" data-calls-summary>
      <span class="${SECTION_TITLE}">Calls</span>
      <span class="${SUMMARY_FIGURE}">${calls.length} ${calls.length === 1 ? 'call' : 'calls'}</span>
      <span class="${SUMMARY_FIGURE}">${formatCost(total)}${subscription ? ' list price' : ''}</span>
      ${rate === null ? '' : html`<span class="${SUMMARY_FIGURE}">${rate} cache hit</span>`}
      ${misses === 0 ? '' : html`<span class="${BADGE} bg-warning-soft text-warning" data-badge="cache-miss" title="Calls whose cache read fell well below the previous call's prompt size">${misses} ${misses === 1 ? 'miss' : 'misses'}</span>`}
    </summary>`;
};

const renderCalls = (
  calls: GenerationRecord[],
  efforts: (string | undefined)[],
  subscription: boolean,
): Rendered => {
  if (calls.length === 0) return '';
  const misses = cacheMisses(calls);
  return html`<details class="${BLOCK} mb-4 border-line" data-calls-section>
    ${renderCallsSummary(calls, misses.size, subscription)}
    <div class="${CARD} rounded-t-none border-x-0 border-b-0" data-calls>
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
    </div>
  </details>`;
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

const SUMMARY_FIGURE = 'text-[0.9rem] tabular-nums text-muted';

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

const renderPullRequestValue = (pullRequest: PullRequestRecord): Rendered =>
  html`<span class="${META_VALUE} flex flex-wrap items-baseline gap-x-3 gap-y-1" data-pull-request>${isGithubUrl(pullRequest.url)
    ? externalLink(pullRequest.url, `#${pullRequest.number}`)
    : html`#${pullRequest.number}`}<span class="${PILL} ${PULL_REQUEST_TONE[pullRequest.state]}" data-pull-request-state="${pullRequest.state}">${pullRequest.state}</span>${pullRequest.rework === null
    ? ''
    : html`<span class="text-[0.9rem] text-muted">rework ${pullRequest.rework}</span>`}</span>`;

const renderRevisedPullRequest = (pullRequest: RevisedPullRequest | null): Rendered =>
  pullRequest === null
    ? ''
    : html`<dt class="${META_TERM}">Revises</dt>
      <dd class="${META_VALUE} flex flex-wrap items-baseline gap-x-3 gap-y-1" data-revised-pull-request><span class="text-muted">${pullRequest.repository}</span>${isGithubUrl(pullRequest.url)
        ? externalLink(pullRequest.url, `#${pullRequest.number}`)
        : html`#${pullRequest.number}`}</dd>`;

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

const renderConfig = (config: RunFingerprint | null): Rendered =>
  html`<dt class="${META_TERM}">Config</dt>
    <dd class="${META_VALUE}" data-cohort>${renderCohortLink(config?.hash ?? null, config?.fingerprint ?? null)}</dd>
    ${config === null
      ? ''
      : html`<dt class="${META_TERM}">Forge</dt>
        <dd class="${META_VALUE} tabular-nums" data-forge-sha>${config.forgeGitSha === null
          ? html`<span class="text-muted">unknown</span>`
          : html`<span title="${config.forgeGitSha}">${config.forgeGitSha.slice(0, SHORT_SHA_LENGTH)}</span>`}</dd>`}`;

const TILE_LABEL = 'm-0 text-xs font-semibold uppercase tracking-[0.05em] text-muted';

const renderTile = (name: string, label: string, value: Rendered, note: Rendered = ''): Rendered =>
  html`<div class="flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-surface px-4 py-3" data-tile="${name}">
      <span class="${TILE_LABEL}">${label}</span>
      <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1 break-words text-[1.15rem] font-semibold tabular-nums [&_[data-badge]]:ml-0" data-tile-value>${value}</div>
      ${note === '' ? '' : html`<span class="${SUMMARY_FIGURE} break-words">${note}</span>`}
    </div>`;

const renderTiles = (
  run: RunRecord,
  generations: GenerationRecord[],
  misses: number,
  hasCalls: boolean,
  pullRequest: PullRequestRecord | null,
): Rendered => html`<div class="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3" data-tiles>
    ${renderTile('cost', 'Cost', renderRunCost(run), renderListPriceTotal(run, generations))}
    ${renderTile('duration', 'Duration', html`<span data-duration>${renderDuration(run)}</span>`, run.endTime === null || run.timeoutSeconds === null ? '' : html`timeout ${formatSpan(run.timeoutSeconds)}`)}
    ${renderTile('tokens', 'Tokens', html`${formatTokens(run.inputTokens)} in`, html`${formatTokens(run.outputTokens)} out`)}
    ${renderTile('cache-hit', 'Cache hit', renderCacheHitRate(run), hasCalls ? html`${misses} ${misses === 1 ? 'miss' : 'misses'}` : '')}
    ${renderTile('tool-calls', 'Tool calls', run.counters === null ? NOT_RECORDED : html`${run.counters.toolCalls}`, run.counters === null ? '' : html`${run.counters.failedToolResults} failed`)}
    ${renderTile('pull-request', 'Pull request', pullRequest === null ? html`<span class="text-muted">none</span>` : renderPullRequestValue(pullRequest))}
  </div>`;

const renderSummary = (run: RunRecord, effort: string): Rendered => html`<p class="m-0 mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[0.9rem]" data-summary>
    ${renderStatus(run.status)}
    ${run.ticket === null
      ? html`<span class="text-muted">manual</span>`
      : html`<span class="flex flex-wrap items-baseline gap-x-3">${renderRunTicket(run.ticket)}${renderAttemptsLink(run.ticket, 'All attempts')}</span>`}
    <span class="break-words">${run.model}</span>
    <span><span class="text-muted">effort</span> <span data-summary-effort>${effort}</span></span>
    ${renderTimestamp(run.startTime)}
  </p>`;

const renderRunError = (run: RunRecord): Rendered => {
  if (run.error === null) return '';
  const tone = run.status === 'interrupted' || run.status === 'exceeded' ? 'bg-warning-soft text-warning' : 'bg-error-soft text-error';
  return html`<details class="mb-4 rounded-lg ${tone}" data-run-error>
    <summary class="block cursor-pointer truncate px-4 py-2.5 before:mr-2.5 before:inline-block before:w-3 before:text-center before:text-[0.65rem] before:transition-transform before:content-['▶'] [[open]>&]:before:rotate-90 [[open]>&]:overflow-visible [[open]>&]:whitespace-normal [[open]>&]:break-words">${run.error}</summary>
  </details>`;
};

const renderRunDetails = (
  run: RunRecord,
  generations: GenerationRecord[],
  revised: RevisedPullRequest | null,
  skillLoads: RunSkillLoad[],
  downloads: Downloads,
  config: RunFingerprint | null,
): Rendered => html`<details open class="${BLOCK} mb-4 border-line" data-run-details data-collapsed-on-phone>
    <summary class="${DISCLOSURE}"><span class="${SECTION_TITLE}">Run details</span></summary>
    <dl class="m-0 grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-6 gap-y-2 border-t border-line px-4 py-3 text-[0.9rem]">
      <dt class="${META_TERM}">Harness</dt>
      <dd class="${META_VALUE}" data-harness>${run.harness}</dd>
      ${renderConfig(config)}
      <dt class="${META_TERM}">Providers</dt>
      <dd class="${META_VALUE}">${renderProviders(run, generations)}</dd>
      <dt class="${META_TERM}">Cache</dt>
      <dd class="${META_VALUE}">${renderCache(run)}</dd>
      ${renderListPriceEquivalent(run, generations)}
      ${renderCounters(run.counters)}
      ${renderSkills(skillLoads)}
      ${renderRevisedPullRequest(revised)}
      ${renderDownloads(run, downloads)}
    </dl>
  </details>`;

export const renderDetail = (
  run: RunRecord,
  events: HarnessEvent[],
  { context, efforts: recordedEfforts }: RequestRecordView,
  generations: GenerationRecord[],
  pullRequest: PullRequestRecord | null,
  revised: RevisedPullRequest | null,
  skillLoads: RunSkillLoad[],
  downloads: Downloads,
  config: RunFingerprint | null,
  assets: AssetHrefs,
): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const live = !isSettled(run);
  const stopped = renderExceeded(run);
  const calls = generations.filter(isCall);
  const efforts = sentEfforts(calls, recordedEfforts);
  const body = html`<div class="flex flex-col gap-2 lg:grid lg:gap-6 lg:h-full lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:grid-rows-[minmax(0,1fr)]">
      <div class="min-w-0 lg:min-h-0 lg:overflow-y-auto lg:pr-2" data-figures>
        <p class="m-0 mb-4 text-[0.9rem]"><a href="/runs" class="${LINK}">&larr; Workloads</a></p>
        <h1 class="${PAGE_TITLE} break-words">${run.worker}</h1>
        ${renderSummary(run, summaryEffort(run, efforts))}
        ${renderTiles(run, generations, cacheMisses(calls).size, calls.length > 0, pullRequest)}
        ${stopped !== '' ? stopped : renderRunError(run)}
        ${renderRunDetails(run, generations, revised, skillLoads, downloads, config)}
        ${renderContext(context)}
        ${renderCalls(calls, efforts, run.costStatus === 'subscription')}
      </div>
      <div class="min-w-0 lg:min-h-0">${renderWidget(run, events)}</div>
    </div>`;
  return layout(run.worker, null, live, assets, body, true);
};
