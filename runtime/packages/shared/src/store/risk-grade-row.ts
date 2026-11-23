import type { GradeOutcome, RecordedRiskGrade, RiskLevel, SupersedeCause } from './store.ts';

export type RiskGradeRow = {
  repository: string;
  number: number;
  head_sha: string;
  fingerprint: string;
  model: string;
  probabilities: string;
  score: number;
  confidence: number;
  level: string;
  uncertain: number;
  cost_usd: number;
  graded_at: string;
  check_posted: number;
  labels_applied: number;
  outcome: string;
  outcome_at: string | null;
  revisions: number | null;
  supersede_cause: string | null;
};

export const riskGradeFromRow = (row: RiskGradeRow): RecordedRiskGrade => ({
  repository: row.repository,
  number: row.number,
  headSha: row.head_sha,
  fingerprint: row.fingerprint,
  model: row.model,
  probabilities: JSON.parse(row.probabilities) as Record<RiskLevel, number>,
  score: row.score,
  confidence: row.confidence,
  level: row.level as RiskLevel,
  uncertain: row.uncertain === 1,
  costUsd: row.cost_usd,
  gradedAt: row.graded_at,
  outcome: row.outcome as GradeOutcome,
  outcomeAt: row.outcome_at,
  revisions: row.revisions,
  supersedeCause: row.supersede_cause as SupersedeCause | null,
});
