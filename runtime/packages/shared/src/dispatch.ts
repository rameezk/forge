export const FORGE_READY = 'forge:ready';
export const FORGE_RUNNING = 'forge:running';
export const FORGE_DONE = 'forge:done';
export const FORGE_FAILED = 'forge:failed';

export const DISPATCH_DETAIL_LIMIT = 2000;

export type DispatchState = 'running' | 'done' | 'failed';

export type DispatchFailure =
  | 'errored'
  | 'no-pull-request'
  | 'skill-not-found'
  | 'devshell-failed'
  | 'interrupted'
  | 'exceeded';

export const ticketKey = (repository: string, number: number): string =>
  `${repository}#${number}`;

export interface DispatchTicket {
  repository: string;
  number: number;
  url: string;
}

export interface DispatchRecord extends DispatchTicket {
  id: number;
  runId: string | null;
  state: DispatchState;
  reason: DispatchFailure | null;
  detail: string | null;
  startedAt: string;
  aliveAt: string;
  endedAt: string | null;
}

export type DispatchStart =
  | { started: number }
  | { refused: 'dispatching' }
  | { refused: 'full'; live: number };

export type DispatchOutcome =
  | { state: 'done' }
  | { state: 'failed'; reason: DispatchFailure; detail: string | null };
