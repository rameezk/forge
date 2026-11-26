import type { TicketAttempt } from './attempts.ts';
import type { RevisedPullRequest } from './revision.ts';
import type { DiagnosisCategory, DiagnosisEvidence, DiagnosisRecord, DiagnosisState } from './diagnosis.ts';
import type { DispatchFailure, DispatchTicket, PullRequestRecord } from './dispatch.ts';

export const BOX_API_PREFIX = '/api';

export const RUNNING_ROUTE = `${BOX_API_PREFIX}/running`;

export const REPOSITORIES_ROUTE = `${BOX_API_PREFIX}/repositories`;

export const ticketRoute = (repository: string, number: number): string =>
  `${BOX_API_PREFIX}/tickets/${encodeURIComponent(repository)}/${number}`;

export const ticketPath = (repository: string, number: number): string =>
  `/tickets/${encodeURIComponent(repository)}/${number}`;

export type AttemptOutcome = PullRequestRecord['state'] | 'running' | 'interrupted' | 'exceeded' | 'failed';

export const attemptOutcome = ({ run, pullRequest }: Pick<TicketAttempt, 'run' | 'pullRequest'>): AttemptOutcome => {
  if (pullRequest !== null) return pullRequest.state;
  if (run.endTime === null) return 'running';
  if (run.status === 'interrupted' || run.status === 'exceeded') return run.status;
  return 'failed';
};

export interface DiagnosisView {
  state: DiagnosisState;
  category: DiagnosisCategory | null;
  evidence: DiagnosisEvidence[];
  suggestedFix: string | null;
  detail: string | null;
}

export const diagnosisView = ({ state, verdict, detail }: DiagnosisRecord): DiagnosisView => ({
  state,
  category: verdict?.category ?? null,
  evidence: verdict?.evidence ?? [],
  suggestedFix: verdict?.suggestedFix ?? null,
  detail,
});

export type PullRequestView = Pick<PullRequestRecord, 'number' | 'url' | 'state'>;

export interface AttemptView {
  runId: string;
  startedAt: string;
  endedAt: string | null;
  outcome: AttemptOutcome;
  failureReason: DispatchFailure | null;
  failureDetail: string | null;
  pullRequest: PullRequestView | null;
  diagnosis: DiagnosisView | null;
  dashboard: string;
}

export interface TicketView {
  repository: string;
  number: number;
  url: string | null;
  dashboard: string;
  outcome: AttemptOutcome | null;
  failureReason: DispatchFailure | null;
  failureDetail: string | null;
  pullRequest: PullRequestView | null;
  diagnosis: DiagnosisView | null;
  attempts: AttemptView[];
}

export interface RunningWorkload {
  runId: string | null;
  startedAt: string;
  runningSeconds: number;
  dashboard: string | null;
}

export interface RunningDispatch extends RunningWorkload {
  ticket: DispatchTicket;
}

export interface RunningPullRequestWorkload extends RunningWorkload {
  pullRequest: RevisedPullRequest;
}

export interface RunningView {
  dispatches: RunningDispatch[];
  revisions: RunningPullRequestWorkload[];
  conflictResolutions: RunningPullRequestWorkload[];
}

export interface RepositoryView {
  name: string;
  github: string;
  ticketPrompt: string | null;
}

export type RepositoriesView = RepositoryView[];
