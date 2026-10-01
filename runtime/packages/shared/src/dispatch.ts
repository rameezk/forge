export const DISPATCH_HEARTBEAT_MS = 20_000;

export const DISPATCH_STALE_MS = 120_000;

export const DISPATCH_DETAIL_LIMIT = 2000;

export type DispatchState = 'running' | 'done' | 'failed';

export type DispatchFailure =
  | 'errored'
  | 'no-pull-request'
  | 'skill-not-found'
  | 'interrupted';

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

export type DispatchOutcome =
  | { state: 'done' }
  | { state: 'failed'; reason: DispatchFailure; detail: string | null };
