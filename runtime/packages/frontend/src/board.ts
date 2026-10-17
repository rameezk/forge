import { oldestFirst, ticketKey, type DispatchRecord, type RefinementRequest, type RepositoryFrontier, type RevisionRecord, type Ticket } from '@forge/shared';

export const COLUMNS = [
  { key: 'to-refine', title: 'To refine', subtitle: 'Shape into a spec and tickets', person: true },
  { key: 'blocked', title: 'Blocked', subtitle: 'Waiting on open blockers', person: false },
  { key: 'ready-for-human', title: 'Ready for human', subtitle: 'A person builds it', person: true },
  { key: 'ready-for-agent', title: 'Ready for agent', subtitle: 'Add forge:ready to hand off', person: false },
  { key: 'waiting-for-slot', title: 'Waiting for slot', subtitle: 'Handed off, unblocked', person: false },
  { key: 'running', title: 'Running', subtitle: 'An agent is building it', person: false },
  { key: 'in-review', title: 'In review', subtitle: 'PR waiting on a human', person: true },
  { key: 'failed', title: 'Failed', subtitle: 'Set forge:ready to retry', person: false },
  { key: 'done', title: 'Done', subtitle: 'Closed in the last 7 days', person: false },
] as const;

export type ColumnKey = (typeof COLUMNS)[number]['key'];

interface CardState {
  dispatch: DispatchRecord | undefined;
  revising: boolean;
}

export type BoardCard =
  | (CardState & { column: 'to-refine'; ticket: RefinementRequest })
  | (CardState & { column: Exclude<ColumnKey, 'to-refine'>; ticket: Ticket });

export type BoardLane = RepositoryFrontier & { columns: Record<ColumnKey, BoardCard[]> };

const columnOf = (ticket: Ticket, dispatch: DispatchRecord | undefined): Exclude<ColumnKey, 'to-refine'> => {
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

export const buildLanes = (
  frontier: RepositoryFrontier[],
  dispatches: ReadonlyMap<string, DispatchRecord>,
  revisions: readonly RevisionRecord[],
): BoardLane[] => {
  const revising = new Set(revisions.filter(({ state }) => state === 'running').map(({ repository, number }) => ticketKey(repository, number)));
  return frontier.map((repository) => {
    const columns = Object.fromEntries(COLUMNS.map(({ key }) => [key, [] as BoardCard[]])) as Record<ColumnKey, BoardCard[]>;
    for (const request of [...repository.requests].sort(oldestFirst)) {
      columns['to-refine'].push({ column: 'to-refine', ticket: request, dispatch: undefined, revising: false });
    }
    for (const ticket of [...repository.tickets].sort(oldestFirst)) {
      const dispatch = dispatches.get(ticketKey(repository.repository, ticket.number));
      const column = columnOf(ticket, dispatch);
      const pullRequest = dispatch?.pullRequest;
      columns[column].push({
        column,
        ticket,
        dispatch,
        revising: column === 'in-review' && pullRequest != null && revising.has(ticketKey(repository.repository, pullRequest.number)),
      });
    }
    return { ...repository, columns };
  });
};

export const totals = (lanes: readonly BoardLane[]): Record<ColumnKey, number> =>
  Object.fromEntries(COLUMNS.map(({ key }) => [key, lanes.reduce((sum, lane) => sum + lane.columns[key].length, 0)])) as Record<ColumnKey, number>;
