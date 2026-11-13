import type { GradingAttempt, GradingStatus } from '@forge/shared';

export const GRADING_ESCALATION_MS = 2 * 3_600_000;

export interface GradingAttention {
  status: GradingStatus;
  now: number;
}

export const needsOperator = ({ status: { failure, failingSince }, now }: GradingAttention): GradingAttempt | null => {
  if (failure === null) return null;
  if (failure.category !== 'temporary') return failure;
  return failingSince !== null && now - Date.parse(failingSince) >= GRADING_ESCALATION_MS ? failure : null;
};
