import { newestClosedFirst, type ConflictResolutionRecord, dispatchOrder, dispatchRefOf, type DispatchOrdering, OLDEST_FIRST, oldestFirst, type GradingAttempt, type RecordedRiskGrade, type PullRequestWorkloadRecord, ticketKey, type ClosedTicket, type DispatchRecord, type RefinementRequest, type RepositoryFrontier, type RevisionRecord, type SpecRef, type Ticket, type DisplayedUrgencyGrade, type UrgencyAttempt } from '@forge/shared';

const HUMAN = 'Needs a human in the loop';

export const COLUMNS = [
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

export type ColumnKey = (typeof COLUMNS)[number]['key'];

export interface LiveWorkload {
  kind: 'dispatch' | 'revision' | 'conflict resolution';
  runId: string | null;
  startedAt: string;
  pullRequest: { number: number; url: string } | null;
}

export interface UntrackedItem {
  subject: 'issue' | 'pull request';
  number: number;
  url: string;
  title: null;
  parent: null;
}

export type RunningSubject = Ticket | ClosedTicket | UntrackedItem;

export const isUntracked = (subject: RunningSubject): subject is UntrackedItem => 'subject' in subject;

export type CardRisk = RecordedRiskGrade | GradingAttempt | 'grading' | null;

export interface RiskInputs {
  repositories: ReadonlySet<string>;
  grades: ReadonlyMap<string, RecordedRiskGrade>;
  attempts: ReadonlyMap<string, GradingAttempt>;
  holds: ReadonlySet<string>;
  sampled?: ReadonlySet<string>;
  paused?: ReadonlySet<string>;
}

export type CardUrgency = DisplayedUrgencyGrade | UrgencyAttempt | null;

export interface UrgencyInputs {
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
}

export type BoardCard =
  | (CardState & { column: 'to-refine'; ticket: RefinementRequest })
  | (CardState & { column: 'done'; ticket: ClosedTicket })
  | (CardState & { column: 'running'; ticket: RunningSubject })
  | (CardState & { column: Exclude<ColumnKey, 'to-refine' | 'running' | 'done'>; ticket: Ticket });

export type Columns = Record<ColumnKey, BoardCard[]>;

export type BoardLane = RepositoryFrontier & { columns: Columns };

export interface SpecBand {
  spec: SpecRef | null;
  columns: Columns;
  count: number;
}

const emptyColumns = (): Columns => Object.fromEntries(COLUMNS.map(({ key }) => [key, [] as BoardCard[]])) as Columns;

const specOf = (card: BoardCard): SpecRef | null => (card.column === 'to-refine' ? null : card.ticket.parent);

export const specBands = (columns: Columns): SpecBand[] => {
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

export const buildLanes = (
  frontier: RepositoryFrontier[],
  dispatches: ReadonlyMap<string, DispatchRecord>,
  revisions: readonly RevisionRecord[],
  conflictResolutions: readonly ConflictResolutionRecord[] = [],
  closes: ReadonlyMap<string, readonly number[]> = new Map(),
  risks: RiskInputs = { repositories: new Set(), grades: new Map(), attempts: new Map(), holds: new Set() },
  urgencies: UrgencyInputs = { grades: new Map(), attempts: new Map() },
  ordering: DispatchOrdering = OLDEST_FIRST,
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

export const totals = (lanes: readonly BoardLane[]): Record<ColumnKey, number> =>
  Object.fromEntries(COLUMNS.map(({ key }) => [key, lanes.reduce((sum, lane) => sum + lane.columns[key].length, 0)])) as Record<ColumnKey, number>;
