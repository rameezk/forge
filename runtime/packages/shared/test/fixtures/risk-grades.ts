import type { RecordedRiskGrade, Store } from '../../src/index.ts';

export const riskGradeOf = (
  store: Store,
  repository: string,
  number: number,
  headSha: string,
): RecordedRiskGrade | null =>
  store.grades
    .riskOptions()
    .cohorts.flatMap((fingerprint) => store.grades.listRiskGrades({ fingerprint }))
    .find((grade) => grade.repository === repository && grade.number === number && grade.headSha === headSha) ?? null;
