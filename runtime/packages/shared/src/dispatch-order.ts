import { ticketKey } from './dispatch.ts';
import { oldestFirst, type RepositoryFrontier, type Ticket } from './frontier.ts';
import { URGENCY_LEVELS, type Store, type UrgencyLevel } from './store/store.ts';

export type DispatchOrder = 'oldest' | 'urgency';

export interface DispatchOrdering {
  order: DispatchOrder;
  priorities: ReadonlyMap<string, number>;
  urgencies: ReadonlyMap<string, UrgencyLevel>;
}

export type DispatchRef = Pick<Ticket, 'createdAt' | 'number'> & { repository: string };

interface Tier {
  urgency: number;
  priority: number;
}

const NORMAL = URGENCY_LEVELS.indexOf('normal');

export const OLDEST_FIRST: DispatchOrdering = {
  order: 'oldest',
  priorities: new Map(),
  urgencies: new Map(),
};

export const certainUrgencies = (
  store: Pick<Store, 'currentUrgencyGrade'>,
  frontier: readonly RepositoryFrontier[],
  order: DispatchOrder,
): Map<string, UrgencyLevel> => {
  const urgencies = new Map<string, UrgencyLevel>();
  if (order === 'oldest') return urgencies;
  for (const { repository, tickets } of frontier) {
    for (const { number } of tickets) {
      const grade = store.currentUrgencyGrade(repository, number);
      if (grade !== null && !grade.uncertain) urgencies.set(ticketKey(repository, number), grade.level);
    }
  }
  return urgencies;
};

const tiersOf = (
  frontier: readonly RepositoryFrontier[],
  { priorities, urgencies }: DispatchOrdering,
): Map<string, Tier> => {
  const tiers = new Map<string, Tier>();
  for (const { repository, tickets } of frontier) {
    const own = (ticket: Ticket): Tier => ({
      urgency: URGENCY_LEVELS.indexOf(urgencies.get(ticketKey(repository, ticket.number)) ?? 'normal'),
      priority: priorities.get(repository) ?? 0,
    });
    const blocking = new Map<number, Ticket[]>();
    for (const ticket of tickets) {
      if (!ticket.forgeReady) continue;
      for (const blocker of ticket.blockedBy) blocking.set(blocker, [...(blocking.get(blocker) ?? []), ticket]);
    }
    for (const ticket of tickets) {
      let best = own(ticket);
      const seen = new Set([ticket.number]);
      const pending = [...(blocking.get(ticket.number) ?? [])];
      for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
        if (seen.has(next.number)) continue;
        seen.add(next.number);
        const tier = own(next);
        best = { urgency: Math.min(best.urgency, tier.urgency), priority: Math.max(best.priority, tier.priority) };
        pending.push(...(blocking.get(next.number) ?? []));
      }
      tiers.set(ticketKey(repository, ticket.number), best);
    }
  }
  return tiers;
};

export const dispatchRefOf = (repository: string, ticket: Pick<Ticket, 'createdAt' | 'number'>): DispatchRef => ({
  repository,
  createdAt: ticket.createdAt,
  number: ticket.number,
});

export const dispatchOrder = (
  frontier: readonly RepositoryFrontier[],
  ordering: DispatchOrdering = OLDEST_FIRST,
): ((a: DispatchRef, b: DispatchRef) => number) => {
  if (ordering.order === 'oldest') return oldestFirst;
  const tiers = tiersOf(frontier, ordering);
  const tierOf = ({ repository, number }: DispatchRef): Tier =>
    tiers.get(ticketKey(repository, number)) ?? { urgency: NORMAL, priority: ordering.priorities.get(repository) ?? 0 };
  return (a, b) => {
    const [left, right] = [tierOf(a), tierOf(b)];
    return left.urgency - right.urgency || right.priority - left.priority || oldestFirst(a, b);
  };
};
