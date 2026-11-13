import { quantile } from './insights.ts';
import { RISK_LEVELS, type RecordedRiskGrade, type RiskLevel } from './store.ts';

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
  superseded: number;
  closed: number;
  open: number;
  heldUpRate: number | null;
  settled: number;
  medianConfidence: number | null;
}

export const RISK_GROUPS: { key: 'candidates' | 'human'; title: string; levels: readonly RiskLevel[] }[] = [
  { key: 'candidates', title: 'Auto-merge candidates', levels: ['trivial', 'low'] },
  { key: 'human', title: 'Reviewed by a human in the loop', levels: ['moderate', 'high'] },
];

const rowOf = (level: RiskLevel, unsettled: boolean, grades: RecordedRiskGrade[]): RiskRow => {
  const count = (outcome: RecordedRiskGrade['outcome']): number => grades.filter((grade) => grade.outcome === outcome).length;
  const merged = count('merged');
  const superseded = count('superseded');
  const closed = count('closed');
  const settled = merged + superseded + closed;
  return {
    level,
    unsettled,
    heads: grades.length,
    pullRequests: new Set(grades.map(({ repository, number }) => `${repository}#${number}`)).size,
    merged,
    superseded,
    closed,
    open: count('open'),
    settled,
    heldUpRate: settled === 0 ? null : merged / settled,
    medianConfidence: grades.length === 0 ? null : quantile(grades.map(({ confidence }) => confidence), 0.5),
  };
};

export const aggregateRisk = (grades: RecordedRiskGrade[]): RiskRow[] =>
  RISK_LEVELS.flatMap((level) =>
    [false, true].map((unsettled) =>
      rowOf(level, unsettled, grades.filter((grade) => grade.level === level && grade.unsettled === unsettled)),
    ),
  );
