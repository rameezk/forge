export const GRADING_FAILURES = ['temporary', 'setup', 'too-large', 'declined', 'bug'] as const;

export type GradingFailure = (typeof GRADING_FAILURES)[number];

export const RETRIED_GRADING_FAILURES: readonly GradingFailure[] = ['temporary', 'setup', 'bug'];

const GRADING_RETRY_BASE_MS = 30_000;

const GRADING_RETRY_CAP_MS = 3_600_000;

export const gradingRetryDelayMs = (failures: number): number =>
  Math.min(GRADING_RETRY_BASE_MS * 2 ** Math.min(failures - 1, 16), GRADING_RETRY_CAP_MS);

export interface LatestAttempt {
  category: string;
  attempted_at: string;
  failures: number;
}

export const attemptHoldsOff = (latest: LatestAttempt, now: string): boolean =>
  !RETRIED_GRADING_FAILURES.includes(latest.category as GradingFailure) ||
  Date.parse(now) < Date.parse(latest.attempted_at) + gradingRetryDelayMs(latest.failures);
