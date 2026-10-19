import { newestClosedFirst, type ConflictResolutionRecord, oldestFirst, ticketKey, type ClosedTicket, type DispatchRecord, type RefinementRequest, type RepositoryFrontier, type RevisionRecord, type SpecRef, type Ticket } from '@forge/shared';

const HUMAN = 'Needs a human in the loop';

export const COLUMNS = [
  { key: 'to-refine', title: 'To refine', subtitle: HUMAN, hint: null, person: true },
  { key: 'blocked', title: 'Blocked', subtitle: 'Waiting on open blockers', hint: null, person: false },
  { key: 'ready-for-human', title: 'Ready for human', subtitle: HUMAN, hint: null, person: true },
  { key: 'ready-for-agent', title: 'Ready for agent', subtitle: 'Not handed off yet', hint: 'Add forge:ready to hand off', person: false },
  { key: 'waiting-for-slot', title: 'Waiting for slot', subtitle: 'Handed off, waiting for a slot', hint: null, person: false },
  { key: 'running', title: 'Running', subtitle: 'An agent is building it', hint: null, person: false },
  { key: 'in-review', title: 'In review', subtitle: HUMAN, hint: null, person: true },
  { key: 'failed', title: 'Failed', subtitle: 'Agent run failed', hint: 'Set forge:ready to retry', person: false },
  { key: 'done', title: 'Done', subtitle: 'Closed in the last 7 days', hint: null, person: false },
] as const;

export type ColumnKey = (typeof COLUMNS)[number]['key'];

interface CardState {
  dispatch: DispatchRecord | undefined;
  revision: RevisionRecord | undefined;
  failedStart: ConflictResolutionRecord | undefined;
}

export type BoardCard =
  | (CardState & { column: 'to-refine'; ticket: RefinementRequest })
  | (CardState & { column: 'done'; ticket: ClosedTicket })
  | (CardState & { column: Exclude<ColumnKey, 'to-refine' | 'done'>; ticket: Ticket });

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

const columnOf = (ticket: Ticket, dispatch: DispatchRecord | undefined): Exclude<ColumnKey, 'to-refine' | 'done'> => {
  if (ticket.blocked) return 'blocked';
  if (ticket.forHuman) return 'ready-for-human';
  if (dispatch?.state === 'running') return 'running';
  if (dispatch?.state === 'failed') return 'failed';
  if (dispatch?.state === 'done') {
    const state = dispatch.pullRequest?.state;
    if (state === 'open') return 'in-review';
    if (state === 'closed') return 'failed';
  }
  return ticket.forgeReady ? 'waiting-for-slot' : 'ready-for-agent';
};

const failedStartOf = (resolution: ConflictResolutionRecord | undefined): ConflictResolutionRecord | undefined =>
  resolution?.reason === 'not-started' ? resolution : undefined;

export const buildLanes = (
  frontier: RepositoryFrontier[],
  dispatches: ReadonlyMap<string, DispatchRecord>,
  revisions: readonly RevisionRecord[],
  conflictResolutions: readonly ConflictResolutionRecord[] = [],
): BoardLane[] => {
  const revising = new Map(revisions.filter(({ state }) => state === 'running').map((revision) => [ticketKey(revision.repository, revision.number), revision]));
  const latestSettled = new Map<string, ConflictResolutionRecord>();
  for (const resolution of conflictResolutions) {
    const key = ticketKey(resolution.repository, resolution.number);
    const known = latestSettled.get(key);
    if (resolution.state !== 'running' && (known === undefined || known.id < resolution.id)) latestSettled.set(key, resolution);
  }
  return frontier.map((repository) => {
    const columns = emptyColumns();
    for (const request of [...repository.requests].sort(oldestFirst)) {
      columns['to-refine'].push({ column: 'to-refine', ticket: request, dispatch: undefined, revision: undefined, failedStart: undefined });
    }
    for (const ticket of [...repository.tickets].sort(oldestFirst)) {
      const dispatch = dispatches.get(ticketKey(repository.repository, ticket.number));
      const column = columnOf(ticket, dispatch);
      const pullRequest = dispatch?.pullRequest;
      columns[column].push({
        column,
        ticket,
        dispatch,
        revision: column === 'in-review' && pullRequest != null ? revising.get(ticketKey(repository.repository, pullRequest.number)) : undefined,
        failedStart: column === 'in-review' && pullRequest != null ? failedStartOf(latestSettled.get(ticketKey(repository.repository, pullRequest.number))) : undefined,
      });
    }
    for (const ticket of [...repository.closed].sort(newestClosedFirst)) {
      columns.done.push({ column: 'done', ticket, dispatch: dispatches.get(ticketKey(repository.repository, ticket.number)), revision: undefined, failedStart: undefined });
    }
    return { ...repository, columns };
  });
};

export const totals = (lanes: readonly BoardLane[]): Record<ColumnKey, number> =>
  Object.fromEntries(COLUMNS.map(({ key }) => [key, lanes.reduce((sum, lane) => sum + lane.columns[key].length, 0)])) as Record<ColumnKey, number>;
