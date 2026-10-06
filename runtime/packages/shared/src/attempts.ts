import type { PullRequestRecord } from './dispatch.ts';
import type { RunFingerprint } from './fingerprint.ts';
import type { RunRecord } from './run.ts';

export interface TicketAttempt {
  run: RunRecord;
  config: RunFingerprint | null;
  pullRequest: PullRequestRecord | null;
}
