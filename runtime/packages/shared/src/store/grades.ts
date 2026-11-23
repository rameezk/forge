import type { Connection } from './connection.ts';
import type { RevisedPullRequest } from '../revision.ts';
import type { RiskFilter, RiskOptions } from '../risk.ts';

export const RISK_LEVELS = ['trivial', 'low', 'moderate', 'high'] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

export interface RiskGrade {
  repository: string;
  number: number;
  headSha: string;
  fingerprint: string;
  model: string;
  probabilities: Record<RiskLevel, number>;
  score: number;
  confidence: number;
  level: RiskLevel;
  uncertain: boolean;
  costUsd: number;
  gradedAt: string;
}

export interface DisplayedGrade extends RecordedRiskGrade {
  checkPosted: boolean;
  labelsApplied: boolean;
}

export const GRADE_OUTCOMES = ['open', 'merged', 'auto-merged', 'superseded', 'closed'] as const;

export type GradeOutcome = (typeof GRADE_OUTCOMES)[number];

export const SUPERSEDE_CAUSES = ['revision', 'conflict-resolution', 'other', 'unknown'] as const;

export type SupersedeCause = (typeof SUPERSEDE_CAUSES)[number];

export interface RecordedRiskGrade extends RiskGrade {
  outcome: GradeOutcome;
  outcomeAt: string | null;
  revisions: number | null;
  supersedeCause: SupersedeCause | null;
}

export const GRADING_FAILURES = ['temporary', 'setup', 'too-large', 'declined', 'bug'] as const;

export type GradingFailure = (typeof GRADING_FAILURES)[number];

export const RETRIED_GRADING_FAILURES: readonly GradingFailure[] = ['temporary', 'setup', 'bug'];

export interface GradingAttempt {
  repository: string;
  number: number;
  headSha: string;
  attemptedAt: string;
  category: GradingFailure;
  message: string;
}

export interface GradingStatus {
  lastSucceededAt: string | null;
  failingSince: string | null;
  failure: GradingAttempt | null;
}

const GRADING_FAILURE_SEVERITY: readonly GradingFailure[] = ['setup', 'bug', 'temporary'];

const GRADING_RETRY_BASE_MS = 30_000;

const GRADING_RETRY_CAP_MS = 3_600_000;

export const notGradedTitle = ({
  category,
  message,
}: Pick<GradingAttempt, 'category' | 'message'>): string =>
  `Not graded: ${message}${RETRIED_GRADING_FAILURES.includes(category) ? ', retrying' : ''}`;

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

type GradingAttemptRow = {
  repository: string;
  number: number;
  head_sha: string;
  attempted_at: string;
  category: string;
  message: string;
  check_posted: number;
};

const gradingAttemptFromRow = (row: GradingAttemptRow): GradingAttempt => ({
  repository: row.repository,
  number: row.number,
  headSha: row.head_sha,
  attemptedAt: row.attempted_at,
  category: row.category as GradingFailure,
  message: row.message,
});

const LATEST_ATTEMPT_OF_UNGRADED_CURRENT_HEADS = `
  SELECT grading_attempts.* FROM grading_attempts
  JOIN feedback_watches
    ON feedback_watches.repository = grading_attempts.repository
    AND feedback_watches.number = grading_attempts.number
    AND feedback_watches.head_sha = grading_attempts.head_sha
  WHERE grading_attempts.id = (
      SELECT max(id) FROM grading_attempts AS later
      WHERE later.repository = grading_attempts.repository
        AND later.number = grading_attempts.number
        AND later.head_sha = grading_attempts.head_sha
    )
    AND NOT EXISTS (
      SELECT 1 FROM risk_grades
      WHERE risk_grades.repository = grading_attempts.repository
        AND risk_grades.number = grading_attempts.number
        AND risk_grades.head_sha = grading_attempts.head_sha
    )
`;

export interface GradingDue {
  repository: string;
  number: number;
  url: string;
  closes: number[];
  headSha: string;
}

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

const displayedGradeFromRow = (row: RiskGradeRow): DisplayedGrade => ({
  ...riskGradeFromRow(row),
  checkPosted: row.check_posted === 1,
  labelsApplied: row.labels_applied === 1,
});

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

type FeedbackWatchRow = {
  repository: string;
  number: number;
  url: string;
  closes: string;
};

export type WorkloadLive = (
  pullRequest: RevisedPullRequest,
  closes: readonly number[],
  now: string,
) => boolean;

export class Grades {
  readonly #db: Connection;
  readonly #workloadLive: WorkloadLive;

  constructor(db: Connection, workloadLive: WorkloadLive) {
    this.#db = db;
    this.#workloadLive = workloadLive;
  }

  gradingDue(repositories: readonly string[], now: string): GradingDue[] {
    const rows = this.#db
      .prepare(
        `SELECT repository, number, url, closes, head_sha FROM feedback_watches
        WHERE mergeable IS NOT NULL
          AND head_sha IS NOT NULL
          AND draft = 0
          AND repository IN (SELECT value FROM json_each($repositories))
          AND NOT EXISTS (
            SELECT 1 FROM risk_grades
            WHERE risk_grades.repository = feedback_watches.repository
              AND risk_grades.number = feedback_watches.number
              AND risk_grades.head_sha = feedback_watches.head_sha
          )
        ORDER BY repository, number`,
      )
      .all({ repositories: JSON.stringify(repositories) }) as (FeedbackWatchRow & {
      head_sha: string;
    })[];
    return rows
      .filter((row) => !this.#gradingHeldOff(row, now))
      .filter((row) => !this.#workloadLive(row, JSON.parse(row.closes) as number[], now))
      .map((row) => ({
        repository: row.repository,
        number: row.number,
        url: row.url,
        closes: JSON.parse(row.closes) as number[],
        headSha: row.head_sha,
      }));
  }

  #gradingHeldOff(
    head: { repository: string; number: number; head_sha: string },
    now: string,
  ): boolean {
    const latest = this.#db
      .prepare(
        `SELECT category, attempted_at,
          (SELECT count(*) FROM grading_attempts AS every
            WHERE every.repository = latest.repository
              AND every.number = latest.number
              AND every.head_sha = latest.head_sha) AS failures
        FROM grading_attempts AS latest
        WHERE repository = $repository AND number = $number AND head_sha = $head_sha
        ORDER BY id DESC LIMIT 1`,
      )
      .get({
        repository: head.repository,
        number: head.number,
        head_sha: head.head_sha,
      }) as LatestAttempt | undefined;
    return latest !== undefined && attemptHoldsOff(latest, now);
  }

  recordGradingAttempt(attempt: GradingAttempt): void {
    const previous = this.#db
      .prepare(
        `SELECT category, message, check_posted FROM grading_attempts
        WHERE repository = $repository AND number = $number AND head_sha = $head_sha
        ORDER BY id DESC LIMIT 1`,
      )
      .get({
        repository: attempt.repository,
        number: attempt.number,
        head_sha: attempt.headSha,
      }) as { category: string; message: string; check_posted: number } | undefined;
    const repeated =
      previous !== undefined &&
      previous.check_posted === 1 &&
      previous.category === attempt.category &&
      previous.message === attempt.message;
    this.#db
      .prepare(
        `INSERT INTO grading_attempts (
          repository, number, head_sha, attempted_at, category, message, check_posted
        ) VALUES (
          $repository, $number, $head_sha, $attempted_at, $category, $message, $check_posted
        )`,
      )
      .run({
        repository: attempt.repository,
        number: attempt.number,
        head_sha: attempt.headSha,
        attempted_at: attempt.attemptedAt,
        category: attempt.category,
        message: attempt.message,
        check_posted: repeated ? 1 : 0,
      });
  }

  attemptsAwaitingCheck(repositories: readonly string[]): GradingAttempt[] {
    const rows = this.#db
      .prepare(
        `${LATEST_ATTEMPT_OF_UNGRADED_CURRENT_HEADS}
          AND grading_attempts.check_posted = 0
          AND grading_attempts.repository IN (SELECT value FROM json_each($repositories))
        ORDER BY grading_attempts.repository, grading_attempts.number`,
      )
      .all({ repositories: JSON.stringify(repositories) }) as GradingAttemptRow[];
    return rows.map(gradingAttemptFromRow);
  }

  markAttemptCheckPosted(attempt: GradingAttempt): void {
    this.#db
      .prepare(
        `UPDATE grading_attempts SET check_posted = 1
        WHERE repository = $repository AND number = $number AND head_sha = $head_sha
          AND attempted_at = $attempted_at`,
      )
      .run({
        repository: attempt.repository,
        number: attempt.number,
        head_sha: attempt.headSha,
        attempted_at: attempt.attemptedAt,
      });
  }

  currentGradingAttempts(): GradingAttempt[] {
    const rows = this.#db
      .prepare(
        `${LATEST_ATTEMPT_OF_UNGRADED_CURRENT_HEADS}
        ORDER BY grading_attempts.repository, grading_attempts.number`,
      )
      .all() as GradingAttemptRow[];
    return rows.map(gradingAttemptFromRow);
  }

  gradingStatus(): GradingStatus {
    const succeeded = this.#db
      .prepare('SELECT max(graded_at) AS at FROM risk_grades')
      .get() as { at: string | null };
    const failing = this.currentGradingAttempts()
      .filter(({ category }) => RETRIED_GRADING_FAILURES.includes(category))
      .toSorted(
        (a, b) =>
          GRADING_FAILURE_SEVERITY.indexOf(a.category) - GRADING_FAILURE_SEVERITY.indexOf(b.category) ||
          (a.attemptedAt < b.attemptedAt ? 1 : -1),
      );
    if (failing.length === 0) return { lastSucceededAt: succeeded.at, failingSince: null, failure: null };
    const firstFailed = this.#db
      .prepare(
        `SELECT min(attempted_at) AS at FROM grading_attempts
        WHERE category IN (SELECT value FROM json_each($categories))
          AND (repository, number, head_sha) IN (
            SELECT value ->> 0, value ->> 1, value ->> 2 FROM json_each($heads))`,
      )
      .get({
        categories: JSON.stringify(RETRIED_GRADING_FAILURES),
        heads: JSON.stringify(failing.map(({ repository, number, headSha }) => [repository, number, headSha])),
      }) as { at: string };
    return { lastSucceededAt: succeeded.at, failingSince: succeeded.at === null || firstFailed.at < succeeded.at ? firstFailed.at : succeeded.at, failure: failing[0]! };
  }
  currentRiskGrades(): RecordedRiskGrade[] {
    const rows = this.#db
      .prepare(
        `SELECT risk_grades.* FROM risk_grades
        JOIN feedback_watches USING (repository, number, head_sha)
        ORDER BY risk_grades.repository, risk_grades.number`,
      )
      .all() as RiskGradeRow[];
    return rows.map(riskGradeFromRow);
  }

  riskOptions(): RiskOptions {
    const column = (sql: string): string[] =>
      (this.#db.prepare(sql).all() as { value: string }[]).map(({ value }) => value);
    return {
      cohorts: column(
        'SELECT fingerprint AS value FROM risk_grades GROUP BY fingerprint ORDER BY max(graded_at) DESC, fingerprint',
      ),
      repositories: column('SELECT DISTINCT repository AS value FROM risk_grades ORDER BY repository'),
    };
  }

  listRiskGrades(filter: RiskFilter): RecordedRiskGrade[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM risk_grades
        WHERE fingerprint = $fingerprint
          AND ($repository IS NULL OR repository = $repository)
          AND ($graded_from IS NULL OR graded_at >= $graded_from)
          AND ($graded_before IS NULL OR graded_at < $graded_before)
        ORDER BY graded_at, repository, number`,
      )
      .all({
        fingerprint: filter.fingerprint,
        repository: filter.repository ?? null,
        graded_from: filter.gradedFrom ?? null,
        graded_before: filter.gradedBefore ?? null,
      }) as RiskGradeRow[];
    return rows.map(riskGradeFromRow);
  }

  listFailedGradingHeads(filter: Omit<RiskFilter, 'fingerprint'>): GradingFailure[] {
    const rows = this.#db
      .prepare(
        `SELECT grading_attempts.category FROM grading_attempts
        WHERE grading_attempts.id = (
            SELECT max(id) FROM grading_attempts AS later
            WHERE later.repository = grading_attempts.repository
              AND later.number = grading_attempts.number
              AND later.head_sha = grading_attempts.head_sha
          )
          AND NOT EXISTS (
            SELECT 1 FROM risk_grades
            WHERE risk_grades.repository = grading_attempts.repository
              AND risk_grades.number = grading_attempts.number
              AND risk_grades.head_sha = grading_attempts.head_sha
          )
          AND ($repository IS NULL OR grading_attempts.repository = $repository)
          AND ($attempted_from IS NULL OR grading_attempts.attempted_at >= $attempted_from)
          AND ($attempted_before IS NULL OR grading_attempts.attempted_at < $attempted_before)`,
      )
      .all({
        repository: filter.repository ?? null,
        attempted_from: filter.gradedFrom ?? null,
        attempted_before: filter.gradedBefore ?? null,
      }) as { category: string }[];
    return rows.map(({ category }) => category as GradingFailure);
  }

  gradesAwaitingDisplay(repositories: readonly string[]): DisplayedGrade[] {
    const rows = this.#db
      .prepare(
        `SELECT risk_grades.* FROM risk_grades
        JOIN feedback_watches USING (repository, number, head_sha)
        WHERE (risk_grades.check_posted = 0 OR risk_grades.labels_applied = 0)
          AND feedback_watches.mergeable IS NOT NULL
          AND risk_grades.repository IN (SELECT value FROM json_each($repositories))
        ORDER BY risk_grades.repository, risk_grades.number`,
      )
      .all({ repositories: JSON.stringify(repositories) }) as RiskGradeRow[];
    return rows.map(displayedGradeFromRow);
  }

  gradesWithStaleLabels(repositories: readonly string[]): DisplayedGrade[] {
    const rows = this.#db
      .prepare(
        `SELECT risk_grades.* FROM risk_grades
        JOIN feedback_watches USING (repository, number)
        WHERE risk_grades.labels_applied = 1
          AND feedback_watches.mergeable IS NOT NULL
          AND feedback_watches.head_sha IS NOT NULL
          AND feedback_watches.head_sha <> risk_grades.head_sha
          AND risk_grades.repository IN (SELECT value FROM json_each($repositories))
        ORDER BY risk_grades.repository, risk_grades.number`,
      )
      .all({ repositories: JSON.stringify(repositories) }) as RiskGradeRow[];
    return rows.map(displayedGradeFromRow);
  }

  markCheckPosted(grade: Pick<RiskGrade, 'repository' | 'number' | 'headSha'>): void {
    this.#db
      .prepare(
        `UPDATE risk_grades SET check_posted = 1
        WHERE repository = $repository AND number = $number AND head_sha = $head_sha`,
      )
      .run({ repository: grade.repository, number: grade.number, head_sha: grade.headSha });
  }

  markLabelsApplied(
    grade: Pick<RiskGrade, 'repository' | 'number' | 'headSha'>,
    applied: boolean,
  ): void {
    this.#db.transaction(() => {
      this.#db
        .prepare(
          `UPDATE risk_grades SET labels_applied = 0
          WHERE repository = $repository AND number = $number`,
        )
        .run({ repository: grade.repository, number: grade.number });
      if (!applied) return;
      this.#db
        .prepare(
          `UPDATE risk_grades SET labels_applied = 1
          WHERE repository = $repository AND number = $number AND head_sha = $head_sha`,
        )
        .run({ repository: grade.repository, number: grade.number, head_sha: grade.headSha });
    });
  }

  recordRiskGrade(grade: RiskGrade): void {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO risk_grades (
          repository, number, head_sha, fingerprint, model, probabilities,
          score, confidence, level, uncertain, cost_usd, graded_at
        ) VALUES (
          $repository, $number, $head_sha, $fingerprint, $model, $probabilities,
          $score, $confidence, $level, $uncertain, $cost_usd, $graded_at
        )`,
      )
      .run({
        repository: grade.repository,
        number: grade.number,
        head_sha: grade.headSha,
        fingerprint: grade.fingerprint,
        model: grade.model,
        probabilities: JSON.stringify(grade.probabilities),
        score: grade.score,
        confidence: grade.confidence,
        level: grade.level,
        uncertain: grade.uncertain ? 1 : 0,
        cost_usd: grade.costUsd,
        graded_at: grade.gradedAt,
      });
  }

  openRiskGrades(repository: string): RecordedRiskGrade[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM risk_grades
        WHERE repository = $repository AND outcome = 'open'
        ORDER BY number, graded_at`,
      )
      .all({ repository }) as RiskGradeRow[];
    return rows.map(riskGradeFromRow);
  }
  settleRiskGrade(
    grade: Pick<RiskGrade, 'repository' | 'number' | 'headSha'>,
    outcome: Exclude<GradeOutcome, 'open'>,
    at: string,
    supersededBy?: string,
  ): void {
    this.#db
      .prepare(
        `UPDATE risk_grades SET
          outcome = CASE
            WHEN $outcome = 'merged' AND auto_merge_started_at IS NOT NULL THEN 'auto-merged'
            ELSE $outcome
          END,
          outcome_at = $at,
          revisions = (
            SELECT COUNT(*) FROM revisions
            WHERE revisions.repository = risk_grades.repository
              AND revisions.number = risk_grades.number
              AND revisions.state = 'done'
              AND revisions.started_at >= risk_grades.graded_at
              AND revisions.started_at <= $at
          ),
          supersede_cause = CASE WHEN $outcome = 'superseded' THEN
            CASE
              WHEN $superseded_by IS NULL THEN 'unknown'
              WHEN EXISTS (
                SELECT 1 FROM revisions
                WHERE revisions.repository = risk_grades.repository
                  AND revisions.number = risk_grades.number
                  AND revisions.pushed_sha = $superseded_by
              ) THEN 'revision'
              WHEN EXISTS (
                SELECT 1 FROM conflict_resolutions
                WHERE conflict_resolutions.repository = risk_grades.repository
                  AND conflict_resolutions.number = risk_grades.number
                  AND conflict_resolutions.pushed_sha = $superseded_by
              ) THEN 'conflict-resolution'
              ELSE 'other'
            END
          END
        WHERE repository = $repository AND number = $number AND head_sha = $head_sha
          AND outcome = 'open'`,
      )
      .run({
        outcome,
        at,
        superseded_by: supersededBy ?? null,
        repository: grade.repository,
        number: grade.number,
        head_sha: grade.headSha,
      });
  }
}
