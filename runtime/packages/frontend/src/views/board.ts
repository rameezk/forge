import { html, raw } from 'hono/html';
import { autoMergeCandidates, autoMergeStatus, certainUrgencies, dispatchOrder, dispatchRefOf, GATE_LABELS, isGithubRepository, isGithubUrl, newestClosedFirst, notGradedTitle, oldestFirst, pullRequestSampled, RETRIED_GRADING_FAILURES, RISK_LEVELS, ticketKey, type ClosedTicket, type ConflictResolutionRecord, type DisplayedUrgencyGrade, type DispatchOrder, type DispatchOrdering, type DispatchRecord, type FailingGate, type GradingAttempt, type PullRequestWorkloadRecord, type RecordedRiskGrade, type RefinementRequest, type RepositoryFrontier, type RevisionRecord, type RiskLevel, type RunRecord, type SpecRef, type Store, type Ticket, type UrgencyAttempt, type UrgencyLevel } from '@forge/shared';
import type { HtmlEscapedString } from 'hono/utils/html';
import { formatElapsed } from '../format.ts';
import { type Rendered, dispatchFailureText as failureText, repeatedStart, detailSuffix, externalLink, PILL, renderTimestamp, laneId, SECTION_TITLE, ERROR_CALLOUT, EMPTY, renderAttemptsLink, renderDate, type Display, PAGE_TITLE, layout } from './shared.ts';

const HUMAN = 'Needs a human in the loop';

const COLUMNS = [
  { key: 'to-refine', title: 'To refine', subtitle: HUMAN, hint: null, person: true },
  { key: 'blocked', title: 'Blocked', subtitle: 'Waiting on open blockers', hint: null, person: false },
  { key: 'ready-for-human', title: 'Ready for human', subtitle: HUMAN, hint: null, person: true },
  { key: 'ready-for-agent', title: 'Ready for agent', subtitle: 'Not handed off yet', hint: 'Add forge:ready to hand off', person: false },
  { key: 'waiting-for-slot', title: 'Waiting for slot', subtitle: 'Handed off, waiting for a slot', hint: null, person: false },
  { key: 'running', title: 'Running', subtitle: 'An agent is working on it', hint: null, person: false },
  { key: 'in-review', title: 'In review', subtitle: HUMAN, hint: null, person: true },
  { key: 'failed', title: 'Failed', subtitle: 'Agent run failed', hint: 'Set forge:ready to retry', person: false },
  { key: 'done', title: 'Done', subtitle: 'Closed in the last 7 days', hint: null, person: false },
] as const;

type ColumnKey = (typeof COLUMNS)[number]['key'];

interface LiveWorkload {
  kind: 'dispatch' | 'revision' | 'conflict resolution';
  runId: string | null;
  startedAt: string;
  pullRequest: { number: number; url: string } | null;
}

interface UntrackedItem {
  subject: 'issue' | 'pull request';
  number: number;
  url: string;
  title: null;
  parent: null;
}

type RunningSubject = Ticket | ClosedTicket | UntrackedItem;

const isUntracked = (subject: RunningSubject): subject is UntrackedItem => 'subject' in subject;

type CardRisk = RecordedRiskGrade | GradingAttempt | 'grading' | null;

interface RiskInputs {
  repositories: ReadonlySet<string>;
  grades: ReadonlyMap<string, RecordedRiskGrade>;
  attempts: ReadonlyMap<string, GradingAttempt>;
  holds: ReadonlySet<string>;
  sampled?: ReadonlySet<string>;
  paused?: ReadonlySet<string>;
  gates?: ReadonlyMap<string, readonly FailingGate[]>;
}

type CardUrgency = DisplayedUrgencyGrade | UrgencyAttempt | null;

interface UrgencyInputs {
  grades: ReadonlyMap<string, DisplayedUrgencyGrade>;
  attempts: ReadonlyMap<string, UrgencyAttempt>;
}

interface CardState {
  risk: CardRisk;
  held: boolean;
  urgency: CardUrgency;
  dispatch: DispatchRecord | undefined;
  workload: LiveWorkload | undefined;
  conflictFailedStart: ConflictResolutionRecord | undefined;
  revisionFailedStart: RevisionRecord | undefined;
  sampled?: boolean;
  paused?: boolean;
  gates?: readonly FailingGate[];
}

type BoardCard =
  | (CardState & { column: 'to-refine'; ticket: RefinementRequest })
  | (CardState & { column: 'done'; ticket: ClosedTicket })
  | (CardState & { column: 'running'; ticket: RunningSubject })
  | (CardState & { column: Exclude<ColumnKey, 'to-refine' | 'running' | 'done'>; ticket: Ticket });

type Columns = Record<ColumnKey, BoardCard[]>;

type BoardLane = RepositoryFrontier & { columns: Columns };

interface SpecBand {
  spec: SpecRef | null;
  columns: Columns;
  count: number;
}

const emptyColumns = (): Columns => Object.fromEntries(COLUMNS.map(({ key }) => [key, [] as BoardCard[]])) as Columns;

const specOf = (card: BoardCard): SpecRef | null => (card.column === 'to-refine' ? null : card.ticket.parent);

const specBands = (columns: Columns): SpecBand[] => {
  const byNumber = new Map<number, SpecBand & { spec: SpecRef }>();
  const loose: SpecBand = { spec: null, columns: emptyColumns(), count: 0 };
  for (const { key } of COLUMNS) {
    for (const card of columns[key]) {
      const spec = specOf(card);
      let band = loose;
      if (spec !== null) {
        const known = byNumber.get(spec.number) ?? { spec, columns: emptyColumns(), count: 0 };
        byNumber.set(spec.number, known);
        band = known;
      }
      band.columns[key].push(card);
      band.count += 1;
    }
  }
  const specs = [...byNumber.values()].sort((a, b) => a.spec.number - b.spec.number);
  return loose.count === 0 ? specs : [...specs, loose];
};

const columnOf = (ticket: Ticket, dispatch: DispatchRecord | undefined): Exclude<ColumnKey, 'to-refine' | 'running' | 'done'> => {
  if (ticket.blocked) return 'blocked';
  if (ticket.forHuman) return 'ready-for-human';
  if (dispatch?.state === 'failed') return 'failed';
  if (dispatch?.state === 'done') {
    const state = dispatch.pullRequest?.state;
    if (state === 'open') return 'in-review';
    if (state === 'closed') return 'failed';
  }
  return ticket.forgeReady ? 'waiting-for-slot' : 'ready-for-agent';
};

const latestSettledOf = <T extends PullRequestWorkloadRecord>(records: readonly T[]): Map<string, T> => {
  const latest = new Map<string, T>();
  for (const record of records) {
    const key = ticketKey(record.repository, record.number);
    const known = latest.get(key);
    if (record.state !== 'running' && (known === undefined || known.id < record.id)) latest.set(key, record);
  }
  return latest;
};

const failedStartOf = <T extends PullRequestWorkloadRecord>(record: T | undefined): T | undefined =>
  record?.reason === 'not-started' ? record : undefined;

const runningCard = (ticket: RunningSubject, dispatch: DispatchRecord | undefined, workload: LiveWorkload): BoardCard => ({
  column: 'running',
  ticket,
  dispatch,
  workload,
  conflictFailedStart: undefined,
  revisionFailedStart: undefined,
  risk: null,
  held: false,
  urgency: null,
});

const untracked = (subject: UntrackedItem['subject'], number: number, url: string): UntrackedItem => ({ subject, number, url, title: null, parent: null });

interface LiveCard {
  startedAt: string;
  card: BoardCard;
}

const liveCards = (
  repository: string,
  onBoard: ReadonlyMap<number, Ticket | ClosedTicket>,
  dispatches: ReadonlyMap<string, DispatchRecord>,
  revisions: readonly RevisionRecord[],
  conflictResolutions: readonly ConflictResolutionRecord[],
  closes: ReadonlyMap<string, readonly number[]>,
): LiveCard[] => {
  const cards: LiveCard[] = [];
  for (const dispatch of dispatches.values()) {
    if (dispatch.repository !== repository || dispatch.state !== 'running') continue;
    const workload: LiveWorkload = { kind: 'dispatch', runId: dispatch.runId, startedAt: dispatch.startedAt, pullRequest: null };
    cards.push({ startedAt: dispatch.startedAt, card: runningCard(onBoard.get(dispatch.number) ?? untracked('issue', dispatch.number, dispatch.url), dispatch, workload) });
  }
  const pullRequestWorkloads: [LiveWorkload['kind'], readonly PullRequestWorkloadRecord[]][] = [
    ['revision', revisions],
    ['conflict resolution', conflictResolutions],
  ];
  for (const [kind, records] of pullRequestWorkloads) {
    for (const record of records) {
      if (record.repository !== repository || record.state !== 'running') continue;
      const tickets = [...new Set(closes.get(ticketKey(repository, record.number)) ?? [])].filter((number) => onBoard.has(number));
      const workload: LiveWorkload = { kind, runId: record.runId, startedAt: record.startedAt, pullRequest: { number: record.number, url: record.url } };
      if (tickets.length === 0) {
        cards.push({ startedAt: record.startedAt, card: runningCard(untracked('pull request', record.number, record.url), undefined, { ...workload, pullRequest: null }) });
      }
      for (const number of tickets) cards.push({ startedAt: record.startedAt, card: runningCard(onBoard.get(number)!, dispatches.get(ticketKey(repository, number)), workload) });
    }
  }
  return cards.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
};

const autoMergedGrade = (risks: RiskInputs, repository: string, dispatch: DispatchRecord | undefined): RecordedRiskGrade | null => {
  const grade = dispatch?.pullRequest == null ? undefined : risks.grades.get(ticketKey(repository, dispatch.pullRequest.number));
  return grade?.outcome === 'auto-merged' ? grade : null;
};

const buildLanes = (
  frontier: RepositoryFrontier[],
  dispatches: ReadonlyMap<string, DispatchRecord>,
  revisions: readonly RevisionRecord[],
  conflictResolutions: readonly ConflictResolutionRecord[],
  closes: ReadonlyMap<string, readonly number[]>,
  risks: RiskInputs,
  urgencies: UrgencyInputs,
  ordering: DispatchOrdering,
): BoardLane[] => {
  const byOrder = dispatchOrder(frontier, ordering);
  const latestResolution = latestSettledOf(conflictResolutions);
  const latestRevision = latestSettledOf(revisions);
  const lanes = frontier.map((repository) => {
    const urgencyOf = (number: number): CardUrgency => urgencies.attempts.get(ticketKey(repository.repository, number)) ?? urgencies.grades.get(ticketKey(repository.repository, number)) ?? null;
    const columns = emptyColumns();
    const onBoard = new Map<number, Ticket | ClosedTicket>([...repository.tickets, ...repository.closed].map((ticket) => [ticket.number, ticket]));
    const live = liveCards(repository.repository, onBoard, dispatches, revisions, conflictResolutions, closes);
    const held = new Set(live.flatMap(({ card }) => (card.column === 'running' && isUntracked(card.ticket) ? [] : [card.ticket.number])));
    for (const request of [...repository.requests].sort(oldestFirst)) {
      columns['to-refine'].push({ column: 'to-refine', ticket: request, dispatch: undefined, workload: undefined, conflictFailedStart: undefined, revisionFailedStart: undefined, risk: null, urgency: null, held: false });
    }
    for (const ticket of [...repository.tickets].sort((a, b) => byOrder(dispatchRefOf(repository.repository, a), dispatchRefOf(repository.repository, b)))) {
      if (held.has(ticket.number)) continue;
      const dispatch = dispatches.get(ticketKey(repository.repository, ticket.number));
      const column = columnOf(ticket, dispatch);
      const pullRequest = dispatch?.pullRequest;
      columns[column].push({
        column,
        ticket,
        dispatch,
        workload: undefined,
        conflictFailedStart: column === 'in-review' && pullRequest != null ? failedStartOf(latestResolution.get(ticketKey(repository.repository, pullRequest.number))) : undefined,
        revisionFailedStart: column === 'in-review' && pullRequest != null ? failedStartOf(latestRevision.get(ticketKey(repository.repository, pullRequest.number))) : undefined,
        sampled: column === 'in-review' && pullRequest != null && risks.sampled?.has(ticketKey(repository.repository, pullRequest.number)) === true,
        paused: column === 'in-review' && pullRequest != null && risks.paused?.has(ticketKey(repository.repository, pullRequest.number)) === true,
        gates: column === 'in-review' && pullRequest != null ? (risks.gates?.get(ticketKey(repository.repository, pullRequest.number)) ?? []) : [],
        urgency: urgencyOf(ticket.number),
        risk: column === 'in-review' && pullRequest != null && risks.repositories.has(repository.repository) ? (risks.grades.get(ticketKey(repository.repository, pullRequest.number)) ?? risks.attempts.get(ticketKey(repository.repository, pullRequest.number)) ?? 'grading') : null,
        held: column === 'in-review' && pullRequest != null && risks.holds.has(ticketKey(repository.repository, pullRequest.number)),
      });
    }
    for (const ticket of [...repository.closed].sort(newestClosedFirst)) {
      if (held.has(ticket.number)) continue;
      const dispatch = dispatches.get(ticketKey(repository.repository, ticket.number));
      columns.done.push({ column: 'done', ticket, dispatch, workload: undefined, conflictFailedStart: undefined, revisionFailedStart: undefined, risk: autoMergedGrade(risks, repository.repository, dispatch), urgency: null, held: false });
    }
    columns.running.push(...live.map(({ card }) => (card.column === 'running' && isUntracked(card.ticket) ? card : { ...card, urgency: urgencyOf(card.ticket.number) })));
    return { ...repository, columns };
  });
  return ordering.order === 'oldest' ? lanes : lanes.toSorted((a, b) => {
    const [left, right] = [a.columns['waiting-for-slot'][0], b.columns['waiting-for-slot'][0]];
    if (left?.column !== 'waiting-for-slot' || right?.column !== 'waiting-for-slot') return Number(left === undefined) - Number(right === undefined);
    return byOrder(dispatchRefOf(a.repository, left.ticket), dispatchRefOf(b.repository, right.ticket));
  });
};

const totals = (lanes: readonly BoardLane[]): Record<ColumnKey, number> =>
  Object.fromEntries(COLUMNS.map(({ key }) => [key, lanes.reduce((sum, lane) => sum + lane.columns[key].length, 0)])) as Record<ColumnKey, number>;

const ROW_GRID = 'sm:grid sm:grid-cols-[repeat(9,minmax(8.5rem,1fr))]';

const LANE_HEAD = 'sticky left-0 w-[calc(100vw-2.25rem)] max-w-full';

const POLLED = 'ml-auto text-sm text-muted';

const MUTED_LINE = 'm-0 mt-1 text-xs text-muted';

const RUNNING_TONE = 'bg-raised text-fg';

const KIND_TONE = 'text-muted ring-1 ring-line ring-inset';

const QUEUED_TONE = 'text-muted ring-1 ring-line ring-inset';

const HUMAN_TONE = 'text-accent-text ring-1 ring-line ring-inset';

const MERGED_TONE = 'bg-success-soft text-success';

const HELD_TONE = 'bg-warning-soft text-warning';

const AWAITING_TONE = HELD_TONE;

const ELAPSED = 'text-xs tabular-nums text-muted';

const FAILURE_LINE = 'm-0 mt-1 line-clamp-4 text-xs break-words whitespace-pre-line text-muted';

const CLOSED_PULL_REQUEST = 'Pull request closed';

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

const renderRunning = ({ workload }: BoardCard, runs: ReadonlyMap<string, RunRecord>): Rendered => {
  if (workload === undefined) return '';
  const pill = html`<span class="${PILL} ${RUNNING_TONE}">running</span>`;
  const { pullRequest } = workload;
  const label = pullRequest === null ? '' : `PR #${pullRequest.number}`;
  return html`<p class="${MUTED_LINE} flex flex-wrap items-center gap-x-1.5 gap-y-1">${renderPill(workload.runId !== null && runs.has(workload.runId) ? workload.runId : null, pill)}${renderElapsedSince(startOf(runs, workload.runId, workload.startedAt))}<span data-workload-kind class="${PILL} ${KIND_TONE}">${workload.kind}</span>${pullRequest === null ? '' : html`${isGithubUrl(pullRequest.url) ? externalLink(pullRequest.url, label) : label}`}</p>`;
};

const renderPullRequestFailedStart = (
  attribute: 'data-conflict-failed-start' | 'data-revision-failed-start',
  label: string,
  { failedStarts, endedAt, startedAt, detail }: PullRequestWorkloadRecord,
  now: Date,
): Rendered => {
  const times = failedStarts ?? 1;
  const since = endedAt ?? startedAt;
  const text = detail === null || detail.trim() === '' ? '' : `: ${detail}`;
  return html`<p ${raw(attribute)} class="${FAILURE_LINE}" title="${label} did not start${text}">${label} did not start (${times} ${times === 1 ? 'time' : 'times'}, last <span data-elapsed-since="${since}">${formatElapsed(now.getTime() - Date.parse(since))}</span> ago)${text}</p>`;
};

const RISK_TONE: Record<RiskLevel, string> = {
  trivial: 'bg-success-soft text-success',
  low: 'bg-raised text-fg',
  moderate: 'bg-warning-soft text-warning',
  high: 'bg-error-soft text-error',
};

const percent = (fraction: number): string => `${Math.round(fraction * 100)}%`;

const runnerUpOf = ({ level, probabilities }: RecordedRiskGrade): RiskLevel =>
  RISK_LEVELS.filter((other) => other !== level).reduce((best, other) => (probabilities[other] > probabilities[best] ? other : best));

const NOT_GRADED_TEXT: Record<GradingAttempt['category'], string> = {
  temporary: 'not graded',
  setup: 'not graded',
  bug: 'not graded',
  declined: 'declined',
  'too-large': 'too large',
};

const renderNotGraded = ({ category, message }: Pick<GradingAttempt, 'category' | 'message'>, attribute: 'data-risk' | 'data-urgency'): Rendered => {
  const retried = RETRIED_GRADING_FAILURES.includes(category);
  const tone = category === 'setup' || category === 'bug' ? 'bg-error-soft text-error' : QUEUED_TONE;
  return html`<p class="${MUTED_LINE}"><span ${raw(attribute)}="${category}" title="${notGradedTitle({ category, message })}" class="${PILL} ${tone} whitespace-nowrap">${NOT_GRADED_TEXT[category]}</span>${retried ? html` <span ${raw(`${attribute}-retrying`)} class="text-xs whitespace-nowrap text-muted">${category}, retrying</span>` : ''}</p>`;
};

const URGENCY_TONE: Record<UrgencyLevel, string> = {
  critical: 'bg-error-soft text-error',
  high: 'bg-warning-soft text-warning',
  normal: 'bg-raised text-fg',
  low: QUEUED_TONE,
};

const renderUrgency = (urgency: CardUrgency): Rendered => {
  if (urgency === null) return '';
  if ('category' in urgency) return renderNotGraded(urgency, 'data-urgency');
  const title = `Urgency ${urgency.level}, confidence ${percent(urgency.confidence)}${urgency.uncertain ? ', uncertain, ordered as normal' : ''}`;
  return html`<p class="${MUTED_LINE} flex flex-wrap items-center gap-x-2 gap-y-0.5"><span data-urgency="${urgency.level}"${urgency.uncertain ? raw(' data-urgency-uncertain') : ''} title="${title}" class="${PILL} ${URGENCY_TONE[urgency.level]}${urgency.uncertain ? ' outline-1 outline-dashed outline-offset-1 outline-current' : ''} whitespace-nowrap">${urgency.level}</span>${urgency.uncertain ? html`<span data-urgency-note class="text-xs text-muted">uncertain, ordered as normal</span>` : ''}</p>`;
};

const renderRisk = (risk: CardRisk): Rendered => {
  if (risk === null) return '';
  if (risk === 'grading') return html`<p class="${MUTED_LINE}"><span data-risk="grading" title="Risk grade pending for the current head commit" class="${PILL} ${QUEUED_TONE}">grading</span></p>`;
  if ('category' in risk) return renderNotGraded(risk, 'data-risk');
  const title = `Risk ${risk.level}, confidence ${percent(risk.confidence)}${risk.uncertain ? `, uncertain, possibly ${runnerUpOf(risk)}` : ''}`;
  return html`<p class="${MUTED_LINE}"><span data-risk="${risk.level}"${risk.uncertain ? raw(' data-risk-uncertain') : ''} title="${title}" class="${PILL} ${RISK_TONE[risk.level]} tabular-nums whitespace-nowrap">${risk.level} ${percent(risk.confidence)}</span>${risk.uncertain ? html` <span data-risk-alternative title="Possible alternative" class="text-xs whitespace-nowrap text-muted">or ${runnerUpOf(risk)}</span>` : ''}</p>`;
};

const renderHold = (): Rendered =>
  html`<p class="${MUTED_LINE}"><span data-hold title="A maintainer put forge:hold on this pull request, so forge does not auto-merge it" class="${PILL} ${HELD_TONE}">held</span></p>`;

const renderSampled = (): Rendered =>
  html`<p class="${MUTED_LINE}"><span data-sampled title="Forge would have auto-merged this pull request and left it for a maintainer to review" class="${PILL} ${HUMAN_TONE}">sampled</span></p>`;

const renderPaused = (): Rendered =>
  html`<p class="${MUTED_LINE}"><span data-paused title="Auto-merge is paused: this pull request would have auto-merged and waits for a maintainer's review" class="${PILL} ${HUMAN_TONE}">paused</span></p>`;

const renderGates = (gates: readonly FailingGate[]): Rendered =>
  gates.length === 0
    ? html``
    : html`<p class="${MUTED_LINE} flex flex-wrap items-center gap-x-1.5 gap-y-1">${gates.map(({ key, detail }) => html`<span data-gate="${key}" title="${detail}" class="${PILL} ${QUEUED_TONE} whitespace-nowrap">${GATE_LABELS[key]}</span>`)}</p>`;

const renderInReview = ({ dispatch, conflictFailedStart, revisionFailedStart, risk, sampled, held, paused, gates }: BoardCard, now: Date): Rendered => {
  const pullRequest = dispatch?.pullRequest;
  if (dispatch === undefined || pullRequest == null) return '';
  const label = `PR #${pullRequest.number}`;
  return html`<p class="${MUTED_LINE}">${isGithubUrl(pullRequest.url) ? externalLink(pullRequest.url, label) : label}</p>${held ? renderHold() : ''}${renderRisk(risk)}${sampled === true ? renderSampled() : ''}${paused === true ? renderPaused() : ''}${renderGates(gates ?? [])}${revisionFailedStart === undefined ? '' : renderPullRequestFailedStart('data-revision-failed-start', 'Revision', revisionFailedStart, now)}${conflictFailedStart === undefined ? '' : renderPullRequestFailedStart('data-conflict-failed-start', 'Conflict resolution', conflictFailedStart, now)}`;
};

const renderFailedStart = (dispatch: DispatchRecord, text: string, now: Date): Rendered => {
  const times = repeatedStart(dispatch);
  const since = dispatch.endedAt ?? dispatch.startedAt;
  return html`<p class="${FAILURE_LINE}" title="${text}">Did not start (${times} times, last <span data-elapsed-since="${since}">${formatElapsed(now.getTime() - Date.parse(since))}</span> ago)${detailSuffix(dispatch)}</p>`;
};

const renderFailure = ({ dispatch }: BoardCard, now: Date): Rendered => {
  const text = dispatch?.state === 'failed' ? failureText(dispatch) : CLOSED_PULL_REQUEST;
  if (text === null) return '';
  return dispatch !== undefined && repeatedStart(dispatch) !== null
    ? renderFailedStart(dispatch, text, now)
    : html`<p class="${FAILURE_LINE}" title="${text}">${text}</p>`;
};

const renderBlockers = (blockedBy: readonly number[], github: string): Rendered => {
  if (blockedBy.length === 0) return html`blocked`;
  const links = blockedBy.map((number) =>
    isGithubRepository(github) ? externalLink(`https://github.com/${github}/issues/${number}`, `#${number}`) : html`#${number}`,
  );
  return html`blocked by ${links.map((link, index) => html`${index === 0 ? '' : ', '}${link}`)}`;
};

const renderAwaitingRedispatch = (ticket: Ticket): Rendered =>
  ticket.awaitingRedispatch === true
    ? html`<p class="${MUTED_LINE}"><span data-awaiting-redispatch title="The latest ready-for-agent came from someone without write access, or someone else edited the ticket or its spec after it. A maintainer applies ready-for-agent again to approve it." class="${PILL} ${AWAITING_TONE} whitespace-nowrap gap-1! px-1.5!">awaiting re-dispatch</span></p>`
    : '';

const renderBlocked = ({ ticket }: { ticket: Ticket }, github: string): Rendered =>
  html`${renderAwaitingRedispatch(ticket)}<p class="${MUTED_LINE}">${ticket.forgeReady ? html`<span data-queued class="${PILL} ${QUEUED_TONE}">queued</span> ` : ''}${ticket.forHuman ? html`<span data-ready-for-human class="${PILL} ${HUMAN_TONE}">ready-for-human</span> ` : ''}${renderBlockers(ticket.blockedBy, github)}</p>`;

const personIcon = (label: string): Rendered =>
  html`<svg data-person role="img" aria-label="${label}" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" class="text-accent-text"><title>${label}</title><circle cx="8" cy="5" r="3" /><path d="M2 14c0-3.3 2.7-5 6-5s6 1.7 6 5z" /></svg>`;

const PERSON_ICON = personIcon('A person acts here');

const BUILT_BY_PERSON_ICON = personIcon('Built by a person');

const renderDone = ({ ticket, dispatch, risk }: BoardCard & { column: 'done' }, timeZone: string): Rendered => {
  const pullRequest = dispatch?.pullRequest;
  const merged = pullRequest != null && pullRequest.state === 'merged';
  return html`<p class="${MUTED_LINE}">${merged ? html`<span data-merged class="${PILL} ${MERGED_TONE}">merged</span> ${risk !== null && risk !== 'grading' && 'outcome' in risk && risk.outcome === 'auto-merged' ? html`<span data-auto-merged title="Merged by forge's Reviewer App without a person" class="${PILL} ${MERGED_TONE}">auto-merged</span> ` : ''}${isGithubUrl(pullRequest.url) ? externalLink(pullRequest.url, `PR #${pullRequest.number}`) : html`PR #${pullRequest.number}`} ` : ''}${renderTimestamp(ticket.closedAt, timeZone)}${ticket.forHuman ? html` <span class="ml-1 inline-flex align-middle">${BUILT_BY_PERSON_ICON}</span>` : ''}</p>`;
};

const isHeld = ({ column, ticket }: BoardCard, full: boolean): boolean =>
  full && (column === 'waiting-for-slot' || column === 'failed') && ticket.forgeReady && !ticket.blocked && !ticket.forHuman;

const renderHeld = (): Rendered =>
  html`<p class="${MUTED_LINE}"><span data-held title="Held back until a pull request is merged or closed" class="${PILL} ${HELD_TONE}">held: review limit</span></p>`;

const renderDetails = (card: BoardCard, github: string, { timeZone, runs, now }: PageContext): Rendered => {
  switch (card.column) {
    case 'blocked':
      return renderBlocked(card, github);
    case 'running':
      return renderRunning(card, runs);
    case 'in-review':
      return renderInReview(card, now);
    case 'failed':
      return renderFailure(card, now);
    case 'done':
      return renderDone(card, timeZone);
    default:
      return html`${card.column === 'to-refine' ? '' : renderAwaitingRedispatch(card.ticket)}<p class="${MUTED_LINE}">${renderDate(card.ticket.createdAt, timeZone)}</p>`;
  }
};

interface PageContext {
  attempted: ReadonlySet<string>;
  timeZone: string;
  runs: ReadonlyMap<string, RunRecord>;
  now: Date;
}

interface Destination {
  href: string;
  label: string;
  external: boolean;
}

const runDestination = (runId: string | null | undefined, runs: ReadonlyMap<string, RunRecord>, number: number): Destination | null =>
  runId == null || !runs.has(runId) ? null : { href: `/runs/${encodeURIComponent(runId)}`, label: `Open run for #${number}`, external: false };

const pullRequestDestination = (dispatch: DispatchRecord | undefined): Destination | null => {
  const pullRequest = dispatch?.pullRequest;
  return pullRequest == null || !isGithubUrl(pullRequest.url) ? null : { href: pullRequest.url, label: `Open PR #${pullRequest.number}`, external: true };
};

const workDestination = ({ column, ticket, dispatch, workload }: BoardCard, runs: ReadonlyMap<string, RunRecord>): Destination | null => {
  switch (column) {
    case 'running':
      return runDestination(workload?.runId, runs, ticket.number);
    case 'in-review':
      return pullRequestDestination(dispatch);
    case 'failed':
      return runDestination(dispatch?.runId, runs, ticket.number);
    default:
      return null;
  }
};

const destinationOf = (card: BoardCard, runs: ReadonlyMap<string, RunRecord>): Destination | null =>
  workDestination(card, runs) ?? (isGithubUrl(card.ticket.url) ? { href: card.ticket.url, label: `Open ${card.column === 'running' && isUntracked(card.ticket) ? card.ticket.subject : 'issue'} #${card.ticket.number}`, external: true } : null);

const CARD_LINK = 'absolute inset-0 cursor-pointer rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

const CARD_HOVER = 'has-[[data-card-link]:hover]:bg-raised';

const INNER_LINKS = '[&_a:not([data-card-link])]:relative [&_a:not([data-card-link])]:z-10';

const renderCardLink = (destination: Destination | null): Rendered =>
  destination === null
    ? ''
    : html`<a href="${destination.href}" data-card-link aria-label="${destination.label}"${destination.external ? raw(' target="_blank" rel="noopener noreferrer"') : ''} class="${CARD_LINK}"></a>`;

const renderCard = (repository: string, github: string, card: BoardCard, grouped: boolean, full: boolean, context: PageContext): Rendered => {
  const { ticket } = card;
  const { attempted, runs } = context;
  const parent = grouped || card.column === 'to-refine' ? null : card.ticket.parent;
  return html`<article data-ticket="${ticket.number}" class="relative rounded-md border border-line bg-surface p-2 text-sm ${CARD_HOVER} ${INNER_LINKS}">
    ${renderCardLink(destinationOf(card, runs))}
    <p class="m-0 tabular-nums">${isGithubUrl(ticket.url) ? externalLink(ticket.url, `#${ticket.number}`) : html`#${ticket.number}`}${attempted.has(ticketKey(repository, ticket.number))
      ? html` <span class="ml-1 text-xs">${renderAttemptsLink({ repository, number: ticket.number }, 'attempts')}</span>`
      : ''}</p>
    ${ticket.title === null ? '' : html`<p class="m-0 mt-1 break-words">${ticket.title}</p>`}
    ${parent === null ? '' : renderSpecLine(parent)}
    ${renderUrgency(card.urgency)}
    ${renderDetails(card, github, context)}
    ${isHeld(card, full) ? renderHeld() : ''}
  </article>`;
};

const renderPolled = (polledAt: string | null, timeZone: string): Rendered =>
  polledAt === null
    ? html`<span class="${POLLED}">Never polled</span>`
    : html`<span class="${POLLED}">Last polled ${renderTimestamp(polledAt, timeZone)}</span>`;

const reviewTaken = ({ pullRequests, running }: ReviewSlots): number => pullRequests + running;

const reviewFull = (review: ReviewSlots): boolean => review.limit !== null && reviewTaken(review) >= review.limit;

const counted = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

const reviewBreakdown = ({ pullRequests, running, limit }: ReviewSlots & { limit: number }, full: boolean): string =>
  `Forge keeps at most ${counted(limit, 'pull request', 'pull requests')} open or on the way. Now: ${pullRequests} open, ${counted(running, 'dispatch', 'dispatches')} that will open one.${full ? ' New dispatches start again when you merge or close one.' : ''}`;

const reviewBadgeText = ({ running }: ReviewSlots): string =>
  `Limit reached · ${running > 0 ? `${counted(running, 'PR', 'PRs')} on the way · ` : ''}new dispatches wait`;

const LIMIT_LINE = 'mt-0.5 block w-fit max-w-full cursor-help text-xs leading-4 text-muted underline decoration-dotted decoration-muted underline-offset-[3px]';

const LIMIT_BADGE = 'mt-0.5 block w-fit max-w-full cursor-help rounded-md px-1.5 py-0.5 text-xs leading-4 font-semibold text-warning bg-warning-soft';

const renderColumnReviewLimit = (review: ReviewSlots): Rendered => {
  if (review.limit === null) return '';
  const full = reviewFull(review);
  const title = reviewBreakdown({ ...review, limit: review.limit }, full);
  return full
    ? html`<span data-review-limit data-full title="${title}" class="${LIMIT_BADGE}">${reviewBadgeText(review)}</span>`
    : html`<span data-review-limit title="${title}" class="${LIMIT_LINE}">Limit ${review.limit}</span>`;
};

const BREAKDOWN_POPOVER = 'm-auto max-w-[min(20rem,calc(100vw-2rem))] rounded-md border border-line bg-surface p-3 text-xs leading-4 text-fg shadow-lg';

const renderStageReviewLimit = (review: ReviewSlots, scope: string): Rendered => {
  if (review.limit === null || !reviewFull(review)) return '';
  const id = `review-limit-${scope}`;
  return html`<button type="button" data-review-limit data-full popovertarget="${id}" class="shrink-0 cursor-pointer rounded-md border-0 px-1.5 text-[0.6875rem] leading-4 font-semibold text-warning bg-warning-soft">Limit reached</button><span popover id="${id}" data-review-breakdown class="${BREAKDOWN_POPOVER}">${reviewBreakdown({ ...review, limit: review.limit }, true)}</span>`;
};

const renderColumnHeaders = (counts: Record<ColumnKey, number>, review: ReviewSlots): Rendered =>
  html`<div class="sticky top-0 z-10 hidden shadow-[0_1px_0_var(--color-line)] ${ROW_GRID}">${COLUMNS.map(
    ({ key, title, subtitle, hint, person }) => html`<div data-column-header="${key}" class="border-b border-line border-l-column-line bg-raised px-2 py-2 sm:border-l sm:first:border-l-0">
      <span class="flex h-4 items-center gap-1"><span data-column-title class="min-w-0 truncate text-[0.7rem] font-semibold leading-4 uppercase tracking-[0.05em] text-fg">${title}</span><span class="ml-auto flex shrink-0 items-center gap-1.5">${person ? html`<span class="flex h-4 shrink-0 items-center">${PERSON_ICON}</span>` : ''}<span data-column-total class="text-xs leading-4 tabular-nums text-muted">${counts[key]}</span></span></span>
      ${key === 'in-review' ? renderColumnReviewLimit(review) : ''}
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

const renderStageHeader = ({ key, title, subtitle, person }: (typeof COLUMNS)[number], count: number, compact: boolean, review: ReviewSlots, scope: string): Rendered =>
  html`<div data-stage-header class="border-y border-line bg-raised px-3 sm:hidden ${compact ? 'py-1' : 'py-2'}">
    <span class="flex h-4 items-center gap-1"><span data-stage-title class="min-w-0 truncate text-[0.7rem] font-semibold leading-4 uppercase tracking-[0.05em] text-fg">${title}</span>${key === 'in-review' ? renderStageReviewLimit(review, scope) : ''}<span class="ml-auto flex shrink-0 items-center gap-1.5">${person && !compact ? html`<span class="flex h-4 shrink-0 items-center">${PERSON_ICON}</span>` : ''}<span data-stage-count class="text-xs leading-4 tabular-nums text-muted">${count}</span></span></span>
    ${compact ? '' : html`<span data-stage-subtitle class="mt-0.5 block truncate text-[0.6875rem] leading-4 text-muted">${subtitle}</span>`}
  </div>`;

const renderRow = (repository: string, github: string, columns: Columns, grouped: boolean, review: ReviewSlots, scope: string, context: PageContext): Rendered =>
  html`<div class="${ROW_GRID}">${COLUMNS.map(
    (column) => html`<div data-column="${column.key}" class="flex flex-col gap-2 border-column-line sm:min-h-12 sm:border-l sm:p-2 sm:first:border-l-0${columns[column.key].length === 0 ? ' max-sm:hidden' : ''}">${renderStageHeader(column, columns[column.key].length, grouped, review, scope)}<div class="flex flex-col gap-2 p-2 sm:contents">${columns[column.key].map((card) => renderCard(repository, github, card, grouped, reviewFull(review), context))}</div></div>`,
  )}</div>`;

const renderBand = (lane: BoardLane, { spec, columns, count }: SpecBand, review: ReviewSlots, context: PageContext): Rendered =>
  html`<div data-spec-band="${spec === null ? 'none' : spec.number}">
    <header data-band-head class="flex items-baseline gap-2.5 border-t border-dashed border-line bg-bg px-3 py-1.5 text-[0.8125rem]">${spec === null
      ? html`<span class="font-semibold text-muted">No spec</span>`
      : html`<span class="tabular-nums">${isGithubUrl(spec.url) ? externalLink(spec.url, `#${spec.number}`) : html`#${spec.number}`}</span><span class="font-semibold">${spec.title}</span>`}<span class="tabular-nums text-muted">${count} ${count === 1 ? 'ticket' : 'tickets'}</span></header>
    ${renderRow(lane.repository, lane.github, columns, true, review, `${laneId(lane.repository)}-${spec === null ? 'none' : spec.number}`, context)}
  </div>`;

const renderLane = (lane: BoardLane, grouped: boolean, review: ReviewSlots, context: PageContext): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const { timeZone } = context;
  const empty = COLUMNS.every(({ key }) => lane.columns[key].length === 0);
  return html`<section id="${laneId(lane.repository)}" class="group scroll-mt-4 border-t border-line" data-repository="${lane.repository}"${empty ? html` data-empty data-collapsed` : ''}${lane.lastError === null ? '' : html` data-stale`}>
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
    ${lane.branchRules === null || lane.branchRules.length === 0
      ? ''
      : html`<p class="${ERROR_CALLOUT} mx-3 mb-2" data-branch-rules>No new work starts here until a sync finds its default branch rules passing: ${lane.branchRules.join('; ')}</p>`}
    </div>
    <div class="group-data-[collapsed]:hidden">${grouped
      ? specBands(lane.columns).map((band) => renderBand(lane, band, review, context))
      : renderRow(lane.repository, lane.github, lane.columns, false, review, laneId(lane.repository), context)}</div>
  </section>`;
};

interface RunningSlots {
  running: number;
  limit: number;
}

const FULL_TONE = 'bg-warning-soft text-warning';
const OPEN_TONE = 'bg-raised text-fg';

const renderRunningLimit = ({ running, limit }: RunningSlots): Rendered => {
  const full = running >= limit;
  return html`<span data-running-limit${full ? html` data-full` : ''} title="Workloads running, out of the global limit" class="${PILL} mb-3 ${full ? FULL_TONE : OPEN_TONE} tabular-nums">Running ${running} / ${limit}</span>`;
};

interface ReviewSlots {
  pullRequests: number;
  running: number;
  limit: number | null;
}

type Grouping = 'none' | 'spec';

const GROUPINGS: readonly { value: Grouping; label: string; href: string }[] = [
  { value: 'none', label: 'None', href: '/' },
  { value: 'spec', label: 'Spec', href: '/?group=spec' },
];

const renderGroupControl = (grouping: Grouping): Rendered =>
  html`<div class="flex items-center gap-2 mb-3"><span id="group-label" class="text-xs text-muted">Group by</span><div data-group-control role="group" aria-labelledby="group-label" class="inline-flex overflow-hidden rounded-md border border-line bg-surface text-[0.8125rem]">${GROUPINGS.map(
    ({ value, label, href }) => html`<a href="${href}"${value === grouping ? html` aria-current="true"` : ''} class="px-3 py-1 no-underline ${value === grouping ? 'bg-raised font-semibold text-fg' : 'text-muted hover:text-fg'}${value === 'none' ? '' : ' border-l border-line'}">${label}</a>`,
  )}</div></div>`;

const groupingOf = (group: string | undefined): Grouping => (group === 'spec' ? 'spec' : 'none');

const keyed = <T extends { repository: string; number: number }>(records: readonly T[]): Map<string, T> =>
  new Map(records.map((record) => [ticketKey(record.repository, record.number), record]));

const keysOf = (records: readonly { repository: string; number: number }[]): Set<string> =>
  new Set(records.map(({ repository, number }) => ticketKey(repository, number)));

const pausedPullRequests = (store: Store, repositories: readonly string[], now: string): Set<string> => {
  if (repositories.length === 0 || autoMergeStatus(store).state !== 'paused') return new Set();
  return keysOf(autoMergeCandidates(store, repositories, now).filter(({ repository, number }) => pullRequestSampled(store, repository, number) !== true));
};

const runsOf = (store: Store, dispatches: readonly DispatchRecord[], pullRequestWorkloads: readonly PullRequestWorkloadRecord[]): Map<string, RunRecord> => {
  const runs = new Map<string, RunRecord>();
  for (const { runId } of [...dispatches, ...pullRequestWorkloads.filter(({ state }) => state === 'running')]) {
    const run = runId === null ? undefined : store.runs.getRun(runId);
    if (run !== undefined) runs.set(run.id, run);
  }
  return runs;
};

export interface BoardSettings {
  maxConcurrent: number;
  maxOpenPullRequests: number | null;
  gradingRepositories: readonly string[];
  autoMergeRepositories: readonly string[];
  dispatchOrder: DispatchOrder;
  repositoryPriorities: Readonly<Record<string, number>>;
}

export interface BoardInput {
  store: Store;
  settings: BoardSettings;
  now: Date;
  group: string | undefined;
  display: Display;
}

export const boardPage = ({ store, settings, now, group, display }: BoardInput): HtmlEscapedString | Promise<HtmlEscapedString> => {
  const at = now.toISOString();
  const grouping = groupingOf(group);
  const dispatches = store.workloads.listDispatches(at);
  const revisions = store.workloads.listRevisions(at);
  const conflictResolutions = store.workloads.listConflictResolutions(at);
  const frontier = store.frontier.listFrontier();
  const ordering: DispatchOrdering = {
    order: settings.dispatchOrder,
    priorities: new Map(Object.entries(settings.repositoryPriorities)),
    urgencies: certainUrgencies(store.urgency, frontier, settings.dispatchOrder),
  };
  const risks: RiskInputs = {
    repositories: new Set(settings.gradingRepositories),
    grades: keyed(store.grades.currentRiskGrades()),
    attempts: keyed(store.grades.currentGradingAttempts()),
    holds: keysOf(store.autoMerge.heldPullRequests()),
    sampled: keysOf(store.autoMerge.sampledPullRequests()),
    paused: pausedPullRequests(store, settings.autoMergeRepositories, at),
    gates: new Map(store.autoMerge.currentFailingGates().filter(({ repository }) => settings.autoMergeRepositories.includes(repository)).map(({ repository, number, gates }) => [ticketKey(repository, number), gates])),
  };
  const urgencies: UrgencyInputs = { grades: keyed(store.urgency.currentGrades()), attempts: keyed(store.urgency.currentAttempts()) };
  const lanes = buildLanes(frontier, keyed(dispatches), revisions, conflictResolutions, store.workloads.closesByPullRequest(), risks, urgencies, ordering);
  const review: ReviewSlots = { ...store.workloads.reviewSlotsTaken(at), limit: settings.maxOpenPullRequests };
  const context: PageContext = { attempted: store.workloads.attemptedTickets(), timeZone: display.timeZone, runs: runsOf(store, dispatches, [...revisions, ...conflictResolutions]), now };
  const body = html`<div class="flex flex-wrap items-center justify-between gap-x-4"><h1 class="${PAGE_TITLE}">Board</h1><div class="flex flex-wrap items-center gap-x-4">${renderGroupControl(grouping)}${renderRunningLimit({ running: store.workloads.liveWorkloads(at), limit: settings.maxConcurrent })}</div></div>
    ${lanes.length === 0
      ? html`<p class="${EMPTY}">No managed repositories have been polled yet.</p>`
      : html`<div data-board class="min-h-0 flex-1 overflow-auto rounded-lg border border-line bg-surface">
          <div class="sm:min-w-[76.5rem]">
            ${renderColumnHeaders(totals(lanes), review)}
            ${lanes.map((lane) => renderLane(lane, grouping === 'spec', review, context))}
          </div>
        </div>`}`;
  return layout('Board', 'board', true, display, body, 'always');
};
