import { quantile } from './insights.ts';
import { GRADING_FAILURES, RISK_LEVELS, SUPERSEDE_CAUSES, type GradingFailure, type RecordedRiskGrade, type RiskLevel, type SupersedeCause } from './store.ts';

export interface RiskFilter {
  fingerprint: string;
  repository?: string;
  gradedFrom?: string;
  gradedBefore?: string;
}

export interface RiskOptions {
  cohorts: string[];
  repositories: string[];
}

export interface RiskRow {
  level: RiskLevel;
  unsettled: boolean;
  heads: number;
  pullRequests: number;
  merged: number;
  supersededBy: Record<SupersedeCause, number>;
  closed: number;
  open: number;
  heldUpRate: number | null;
  judged: number;
  medianConfidence: number | null;
  meanRevisions: number | null;
}

export const RISK_GROUPS: { key: 'candidates' | 'human'; title: string; levels: readonly RiskLevel[] }[] = [
  { key: 'candidates', title: 'Auto-merge candidates', levels: ['trivial', 'low'] },
  { key: 'human', title: 'Reviewed by a human in the loop', levels: ['moderate', 'high'] },
];

const rowOf = (level: RiskLevel, unsettled: boolean, grades: RecordedRiskGrade[]): RiskRow => {
  const count = (outcome: RecordedRiskGrade['outcome']): number => grades.filter((grade) => grade.outcome === outcome).length;
  const merged = count('merged');
  const supersededBy = Object.fromEntries(
    SUPERSEDE_CAUSES.map((cause) => [
      cause,
      grades.filter((grade) => grade.outcome === 'superseded' && grade.supersedeCause === cause).length,
    ]),
  ) as Record<SupersedeCause, number>;
  const closed = count('closed');
  const judged = merged + closed + grades.filter((grade) => grade.outcome === 'superseded').length - supersededBy['conflict-resolution'];
  const revisions = grades.flatMap(({ outcome, revisions: after }) => (outcome !== 'open' && after !== null ? [after] : []));
  return {
    level,
    unsettled,
    heads: grades.length,
    pullRequests: new Set(grades.map(({ repository, number }) => `${repository}#${number}`)).size,
    merged,
    supersededBy,
    closed,
    open: count('open'),
    judged,
    heldUpRate: judged === 0 ? null : merged / judged,
    meanRevisions: revisions.length === 0 ? null : revisions.reduce((sum, value) => sum + value, 0) / revisions.length,
    medianConfidence: grades.length === 0 ? null : quantile(grades.map(({ confidence }) => confidence), 0.5),
  };
};

export const aggregateRisk = (grades: RecordedRiskGrade[]): RiskRow[] =>
  RISK_LEVELS.flatMap((level) =>
    [false, true].map((unsettled) =>
      rowOf(level, unsettled, grades.filter((grade) => grade.level === level && grade.unsettled === unsettled)),
    ),
  );

export interface RiskSummary {
  graded: number;
  attempted: number;
  failed: Record<GradingFailure, number>;
  coverage: number | null;
  costUsd: number;
  costPerGrade: number | null;
  candidates: { merged: number; judged: number; heldUpRate: number | null };
}

export const summarizeRisk = (grades: RecordedRiskGrade[], failedHeads: GradingFailure[]): RiskSummary => {
  const failed = Object.fromEntries(
    GRADING_FAILURES.map((category) => [category, failedHeads.filter((failure) => failure === category).length]),
  ) as Record<GradingFailure, number>;
  const costUsd = grades.reduce((total, grade) => total + grade.costUsd, 0);
  const candidateLevels = RISK_GROUPS.find(({ key }) => key === 'candidates')?.levels ?? [];
  const candidates = aggregateRisk(grades)
    .filter(({ level, unsettled }) => candidateLevels.includes(level) && !unsettled)
    .reduce((total, row) => ({ merged: total.merged + row.merged, judged: total.judged + row.judged }), { merged: 0, judged: 0 });
  const attempted = grades.length + failedHeads.length;
  return {
    graded: grades.length,
    attempted,
    failed,
    coverage: attempted === 0 ? null : grades.length / attempted,
    costUsd,
    costPerGrade: grades.length === 0 ? null : costUsd / grades.length,
    candidates: { ...candidates, heldUpRate: candidates.judged === 0 ? null : candidates.merged / candidates.judged },
  };
};
