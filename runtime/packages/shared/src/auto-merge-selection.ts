import { autoMergeStateOf, PAUSE_WINDOW, type AutoMergeStatus } from './auto-merge-status.ts';
import { riskGradeFromRow, type RecordedRiskGrade, type RiskGradeRow } from './store/grades.ts';
import type { Store } from './store/store.ts';

export interface CandidateFacts {
  grade: RecordedRiskGrade;
  draft: boolean;
  mergeable: boolean;
  feedbackOpen: boolean;
  workloadRunning: boolean;
}

export const candidatesWithFacts = (store: Store, repositories: readonly string[], now: string): CandidateFacts[] =>
  store
    .read<RiskGradeRow & { watch_draft: number | null; watch_mergeable: string | null; watch_newest: string | null }>(
      `SELECT risk_grades.*,
        feedback_watches.draft AS watch_draft,
        feedback_watches.mergeable AS watch_mergeable,
        feedback_watches.newest AS watch_newest
      FROM risk_grades
      JOIN feedback_watches USING (repository, number, head_sha)
      WHERE risk_grades.outcome = 'open'
        AND risk_grades.level IN ('trivial', 'low')
        AND risk_grades.uncertain = 0
        AND risk_grades.repository IN (SELECT value FROM json_each($repositories))
        AND NOT EXISTS (
          SELECT 1 FROM auto_merge_samples
          WHERE auto_merge_samples.repository = risk_grades.repository
            AND auto_merge_samples.number = risk_grades.number
            AND auto_merge_samples.sampled = 1
            AND auto_merge_samples.announced = 1
        )
      ORDER BY risk_grades.repository, risk_grades.number`,
      { repositories: JSON.stringify(repositories) },
    )
    .map((row) => {
      const grade = riskGradeFromRow(row);
      return {
        grade,
        draft: row.watch_draft === 1,
        mergeable: row.watch_mergeable !== null && row.watch_draft !== null,
        feedbackOpen: row.watch_newest !== null,
        workloadRunning: store.autoMerge.workloadRunning(grade.repository, grade.number, now),
      };
    });

export const autoMergeCandidates = (store: Store, repositories: readonly string[], now: string): RecordedRiskGrade[] =>
  candidatesWithFacts(store, repositories, now)
    .filter(({ draft, mergeable, feedbackOpen, workloadRunning }) => !draft && mergeable && !feedbackOpen && !workloadRunning)
    .map(({ grade }) => grade);

export const pullRequestSampled = (store: Store, repository: string, number: number): boolean | null => {
  const [row] = store.read<{ sampled: number }>(
    `SELECT sampled FROM auto_merge_samples WHERE repository = $repository AND number = $number`,
    { repository, number },
  );
  return row === undefined ? null : row.sampled === 1;
};

export const drawSample = (
  store: Store,
  repository: string,
  number: number,
  draw: () => boolean,
  at: string,
  forced = false,
): boolean => {
  const known = pullRequestSampled(store, repository, number);
  if (known === true || (known === false && !forced)) return known;
  const sampled = forced || draw();
  store.autoMerge.recordSample(repository, number, sampled, at);
  return sampled;
};

export const autoMergeStatus = (store: Store): AutoMergeStatus => {
  const [current] = store.read<{ fingerprint: string }>(
    'SELECT fingerprint FROM risk_grades ORDER BY graded_at DESC, rowid DESC LIMIT 1',
  );
  const fingerprint = current?.fingerprint ?? null;
  const [counted] = store.read<{ settled: number }>(
    `SELECT COUNT(*) AS settled FROM risk_grades
    WHERE fingerprint = $fingerprint AND level IN ('trivial', 'low') AND outcome <> 'open'`,
    { fingerprint },
  );
  const settled = counted?.settled ?? 0;
  const window = store.read<{ outcome: string }>(
    `SELECT outcome FROM risk_grades
    WHERE fingerprint = $fingerprint AND level IN ('trivial', 'low')
      AND (outcome IN ('merged', 'closed')
        OR (outcome = 'superseded' AND supersede_cause IS NOT 'conflict-resolution'))
    ORDER BY outcome_at DESC, rowid DESC
    LIMIT $window`,
    { fingerprint, window: PAUSE_WINDOW },
  );
  const counts = {
    settled,
    heldUp: window.filter(({ outcome }) => outcome === 'merged').length,
    judged: window.length,
  };
  return { ...counts, state: autoMergeStateOf(counts) };
};
