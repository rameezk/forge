import type { Connection } from './connection.ts';
import { attemptHoldsOff, type GradingFailure, type LatestAttempt } from './grading-policy.ts';

export const URGENCY_LEVELS = ['critical', 'high', 'normal', 'low'] as const;

export type UrgencyLevel = (typeof URGENCY_LEVELS)[number];

export interface UrgencyGrade {
  repository: string;
  number: number;
  version: string;
  fingerprint: string;
  model: string;
  probabilities: Record<UrgencyLevel, number>;
  score: number;
  confidence: number;
  level: UrgencyLevel;
  uncertain: boolean;
  costUsd: number;
  gradedAt: string;
}

export interface UrgencyAttempt {
  repository: string;
  number: number;
  version: string;
  attemptedAt: string;
  category: GradingFailure;
  message: string;
}

export interface UrgencyDue {
  repository: string;
  number: number;
  version: string;
}

export interface DisplayedUrgencyGrade extends UrgencyGrade {
  labelsApplied: boolean;
}

type UrgencyGradeRow = {
  repository: string;
  number: number;
  version: string;
  fingerprint: string;
  model: string;
  probabilities: string;
  score: number;
  confidence: number;
  level: string;
  uncertain: number;
  cost_usd: number;
  graded_at: string;
  labels_applied: number;
};

type UrgencyAttemptRow = {
  repository: string;
  number: number;
  version: string;
  attempted_at: string;
  category: string;
  message: string;
};

const urgencyAttemptFromRow = (row: UrgencyAttemptRow): UrgencyAttempt => ({
  repository: row.repository,
  number: row.number,
  version: row.version,
  attemptedAt: row.attempted_at,
  category: row.category as GradingFailure,
  message: row.message,
});

const urgencyGradeFromRow = (row: UrgencyGradeRow): DisplayedUrgencyGrade => ({
  repository: row.repository,
  number: row.number,
  version: row.version,
  fingerprint: row.fingerprint,
  model: row.model,
  probabilities: JSON.parse(row.probabilities) as Record<UrgencyLevel, number>,
  score: row.score,
  confidence: row.confidence,
  level: row.level as UrgencyLevel,
  uncertain: row.uncertain === 1,
  costUsd: row.cost_usd,
  gradedAt: row.graded_at,
  labelsApplied: row.labels_applied === 1,
});

const CREATE_URGENCY_GRADES = `
  CREATE TABLE IF NOT EXISTS urgency_grades (
    repository     TEXT NOT NULL,
    number         INTEGER NOT NULL,
    version        TEXT NOT NULL,
    fingerprint    TEXT NOT NULL,
    model          TEXT NOT NULL,
    probabilities  TEXT NOT NULL,
    score          REAL NOT NULL,
    confidence     REAL NOT NULL,
    level          TEXT NOT NULL,
    uncertain      INTEGER NOT NULL,
    cost_usd       REAL NOT NULL,
    graded_at      TEXT NOT NULL,
    labels_applied INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (repository, number, version)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS urgency_attempts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    repository   TEXT NOT NULL,
    number       INTEGER NOT NULL,
    version      TEXT NOT NULL,
    attempted_at TEXT NOT NULL,
    category     TEXT NOT NULL,
    message      TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS urgency_attempts_version
    ON urgency_attempts (repository, number, version);
`;

export const migrateUrgency = (connection: Connection): void => {
  connection.exec(CREATE_URGENCY_GRADES);
};

export class Urgency {
  readonly #db: Connection;

  constructor(db: Connection) {
    this.#db = db;
  }

  due(repositories: readonly string[], now: string): UrgencyDue[] {
    const rows = this.#db
      .prepare(
        `SELECT repository, number, version FROM frontier_tickets
        WHERE forge_ready = 1
          AND version <> ''
          AND repository IN (SELECT value FROM json_each($repositories))
          AND NOT EXISTS (
            SELECT 1 FROM urgency_grades
            WHERE urgency_grades.repository = frontier_tickets.repository
              AND urgency_grades.number = frontier_tickets.number
              AND urgency_grades.version = frontier_tickets.version
          )
        ORDER BY repository, number`,
      )
      .all({ repositories: JSON.stringify(repositories) }) as unknown as UrgencyDue[];
    return rows.filter((row) => !this.#heldOff(row, now));
  }

  #heldOff(due: UrgencyDue, now: string): boolean {
    const latest = this.#db
      .prepare(
        `SELECT category, attempted_at,
          (SELECT count(*) FROM urgency_attempts AS every
            WHERE every.repository = latest.repository
              AND every.number = latest.number
              AND every.version = latest.version) AS failures
        FROM urgency_attempts AS latest
        WHERE repository = $repository AND number = $number AND version = $version
        ORDER BY id DESC LIMIT 1`,
      )
      .get({
        repository: due.repository,
        number: due.number,
        version: due.version,
      }) as LatestAttempt | undefined;
    return latest !== undefined && attemptHoldsOff(latest, now);
  }

  recordAttempt(attempt: UrgencyAttempt): void {
    this.#db
      .prepare(
        `INSERT INTO urgency_attempts (
          repository, number, version, attempted_at, category, message
        ) VALUES (
          $repository, $number, $version, $attempted_at, $category, $message
        )`,
      )
      .run({
        repository: attempt.repository,
        number: attempt.number,
        version: attempt.version,
        attempted_at: attempt.attemptedAt,
        category: attempt.category,
        message: attempt.message,
      });
  }

  recordGrade(grade: UrgencyGrade): void {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO urgency_grades (
          repository, number, version, fingerprint, model, probabilities,
          score, confidence, level, uncertain, cost_usd, graded_at
        ) VALUES (
          $repository, $number, $version, $fingerprint, $model, $probabilities,
          $score, $confidence, $level, $uncertain, $cost_usd, $graded_at
        )`,
      )
      .run({
        repository: grade.repository,
        number: grade.number,
        version: grade.version,
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

  currentGrade(repository: string, number: number): DisplayedUrgencyGrade | null {
    const row = this.#db
      .prepare(
        `SELECT urgency_grades.* FROM urgency_grades
        LEFT JOIN frontier_tickets
          ON frontier_tickets.repository = urgency_grades.repository
          AND frontier_tickets.number = urgency_grades.number
        WHERE urgency_grades.repository = $repository AND urgency_grades.number = $number
        ORDER BY urgency_grades.version = frontier_tickets.version DESC,
          urgency_grades.graded_at DESC, urgency_grades.rowid DESC LIMIT 1`,
      )
      .get({ repository, number }) as UrgencyGradeRow | undefined;
    return row === undefined ? null : urgencyGradeFromRow(row);
  }

  currentGrades(): DisplayedUrgencyGrade[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM (
          SELECT urgency_grades.*, row_number() OVER (
            PARTITION BY urgency_grades.repository, urgency_grades.number
            ORDER BY urgency_grades.version = frontier_tickets.version DESC,
              urgency_grades.graded_at DESC, urgency_grades.rowid DESC
          ) AS rank
          FROM urgency_grades
          JOIN frontier_tickets
            ON frontier_tickets.repository = urgency_grades.repository
            AND frontier_tickets.number = urgency_grades.number
        ) WHERE rank = 1
        ORDER BY repository, number`,
      )
      .all() as UrgencyGradeRow[];
    return rows.map(urgencyGradeFromRow);
  }

  currentAttempts(): UrgencyAttempt[] {
    const rows = this.#db
      .prepare(
        `SELECT urgency_attempts.* FROM urgency_attempts
        JOIN frontier_tickets
          ON frontier_tickets.repository = urgency_attempts.repository
          AND frontier_tickets.number = urgency_attempts.number
          AND frontier_tickets.version = urgency_attempts.version
        WHERE urgency_attempts.id = (
            SELECT max(id) FROM urgency_attempts AS later
            WHERE later.repository = urgency_attempts.repository
              AND later.number = urgency_attempts.number
              AND later.version = urgency_attempts.version
          )
          AND NOT EXISTS (
            SELECT 1 FROM urgency_grades
            WHERE urgency_grades.repository = urgency_attempts.repository
              AND urgency_grades.number = urgency_attempts.number
              AND urgency_grades.version = urgency_attempts.version
          )
        ORDER BY urgency_attempts.repository, urgency_attempts.number`,
      )
      .all() as UrgencyAttemptRow[];
    return rows.map(urgencyAttemptFromRow);
  }

  gradesAwaitingLabels(repositories: readonly string[]): DisplayedUrgencyGrade[] {
    const rows = this.#db
      .prepare(
        `SELECT urgency_grades.* FROM urgency_grades
        JOIN frontier_tickets
          ON frontier_tickets.repository = urgency_grades.repository
          AND frontier_tickets.number = urgency_grades.number
          AND frontier_tickets.version = urgency_grades.version
        WHERE urgency_grades.labels_applied = 0
          AND urgency_grades.repository IN (SELECT value FROM json_each($repositories))
        ORDER BY urgency_grades.repository, urgency_grades.number`,
      )
      .all({ repositories: JSON.stringify(repositories) }) as UrgencyGradeRow[];
    return rows.map(urgencyGradeFromRow);
  }

  markLabelsApplied(grade: Pick<UrgencyGrade, 'repository' | 'number' | 'version'>): void {
    this.#db
      .prepare(
        `UPDATE urgency_grades SET labels_applied = (version = $version)
        WHERE repository = $repository AND number = $number`,
      )
      .run({ repository: grade.repository, number: grade.number, version: grade.version });
  }
}
