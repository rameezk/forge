import type { RevisedPullRequest, RevisionRecord, RevisionState } from './revision.ts';

export type ConflictResolutionState = RevisionState;

export interface ShaPair {
  headSha: string;
  defaultSha: string;
}

export type ConflictResolutionFailure =
  | 'not-merged'
  | 'still-conflicting'
  | 'check-failed'
  | 'check-pending'
  | 'crashed';

export interface ConflictResolutionFailureRecord {
  reason: ConflictResolutionFailure;
  detail: string | null;
}

export interface ConflictResolutionRecord extends RevisedPullRequest {
  id: number;
  runId: string;
  dispatchId: number | null;
  state: ConflictResolutionState;
  reason: ConflictResolutionFailure | null;
  detail: string | null;
  startedAt: string;
  aliveAt: string;
  endedAt: string | null;
}

export type ConflictResolutionStart =
  | { started: number }
  | { refused: 'resolving' }
  | { refused: 'revising' }
  | { refused: 'dispatching' }
  | { refused: 'full'; live: number };

export type PullRequestWorkloadRecord = RevisionRecord | ConflictResolutionRecord;

export interface RunPullRequestWorkload {
  kind: 'revision' | 'conflict-resolution';
  workload: PullRequestWorkloadRecord;
}
