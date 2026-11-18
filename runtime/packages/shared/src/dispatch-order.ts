import { oldestFirst, type Ticket } from './frontier.ts';

export const dispatchOrder = (
  a: Pick<Ticket, 'createdAt' | 'number'>,
  b: Pick<Ticket, 'createdAt' | 'number'>,
): number => oldestFirst(a, b);
