import type { PullRequestRecord } from './dispatch.ts';
import type { RunFingerprint } from './fingerprint.ts';
import type { RevisionRecord } from './revision.ts';
import type { RunRecord } from './run.ts';

export interface AttemptRevision {
  revision: RevisionRecord;
  run: RunRecord;
}

export interface TicketAttempt {
  run: RunRecord;
  config: RunFingerprint | null;
  pullRequest: PullRequestRecord | null;
  revisions: AttemptRevision[];
}
