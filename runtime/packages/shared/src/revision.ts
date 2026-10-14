export type RevisionState = 'running' | 'ok' | 'error' | 'exceeded' | 'interrupted';

export interface RevisedPullRequest {
  repository: string;
  number: number;
  url: string;
}

export interface RevisionRecord extends RevisedPullRequest {
  id: number;
  runId: string;
  dispatchId: number | null;
  state: RevisionState;
  startedAt: string;
  aliveAt: string;
  endedAt: string | null;
}

export type RevisionStart =
  | { started: number }
  | { refused: 'revising' }
  | { refused: 'dispatching' }
  | { refused: 'full'; live: number };
