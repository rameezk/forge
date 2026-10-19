export type RevisionState = 'running' | 'ok' | 'error' | 'exceeded' | 'interrupted';

export type RevisionFailure = 'unanswered' | 'crashed' | 'not-started';

export interface RevisionFailureRecord {
  reason: RevisionFailure;
  detail: string | null;
}

export interface RevisedPullRequest {
  repository: string;
  number: number;
  url: string;
}

export interface RevisionRecord extends RevisedPullRequest {
  id: number;
  runId: string | null;
  dispatchId: number | null;
  state: RevisionState;
  reason: RevisionFailure | null;
  detail: string | null;
  failedStarts: number | null;
  startedAt: string;
  aliveAt: string;
  endedAt: string | null;
}

export type RevisionStart =
  | { started: number; after: string | null }
  | { refused: 'revising' }
  | { refused: 'dispatching' }
  | { refused: 'resolving' }
  | { refused: 'full'; live: number };
