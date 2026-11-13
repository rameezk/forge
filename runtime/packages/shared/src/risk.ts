import { quantile } from './insights.ts';
import { RISK_LEVELS, SUPERSEDE_CAUSES, type RecordedRiskGrade, type RiskLevel, type SupersedeCause } from './store.ts';

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
    medianConfidence: grades.length === 0 ? null : quantile(grades.map(({ confidence }) => confidence), 0.5),
  };
};

export const aggregateRisk = (grades: RecordedRiskGrade[]): RiskRow[] =>
  RISK_LEVELS.flatMap((level) =>
    [false, true].map((unsettled) =>
      rowOf(level, unsettled, grades.filter((grade) => grade.level === level && grade.unsettled === unsettled)),
    ),
  );
