import type { Connection } from '../connection.ts';
import { addColumnsOnce, migrateWhenNeeded } from './steps.ts';

const HAS_GRADE_SUPERSEDE_CAUSE = `
  SELECT 1 FROM pragma_table_info('risk_grades') WHERE name = 'supersede_cause'
`;

const ADD_GRADE_SUPERSEDE_CAUSE = `
  ALTER TABLE risk_grades ADD COLUMN supersede_cause TEXT;
  UPDATE risk_grades SET supersede_cause = 'unknown' WHERE outcome = 'superseded';
`;

const CONFLICT_RESOLUTION_SUPERSEDED_AS_OTHER = `
  FROM risk_grades
  WHERE outcome = 'superseded' AND supersede_cause = 'other'
    AND EXISTS (
      SELECT 1 FROM conflict_resolutions
      WHERE conflict_resolutions.repository = risk_grades.repository
        AND conflict_resolutions.number = risk_grades.number
        AND conflict_resolutions.pushed_sha = (
          SELECT next.head_sha FROM risk_grades AS next
          WHERE next.repository = risk_grades.repository
            AND next.number = risk_grades.number
            AND next.graded_at > risk_grades.graded_at
          ORDER BY next.graded_at LIMIT 1
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM revisions
      WHERE revisions.repository = risk_grades.repository
        AND revisions.number = risk_grades.number
        AND revisions.pushed_sha = (
          SELECT next.head_sha FROM risk_grades AS next
          WHERE next.repository = risk_grades.repository
            AND next.number = risk_grades.number
            AND next.graded_at > risk_grades.graded_at
          ORDER BY next.graded_at LIMIT 1
        )
    )
`;

const HAS_MISATTRIBUTED_CONFLICT_RESOLUTION_SUPERSEDE = `SELECT 1 ${CONFLICT_RESOLUTION_SUPERSEDED_AS_OTHER}`;

const CORRECT_CONFLICT_RESOLUTION_SUPERSEDES = `
  UPDATE risk_grades SET supersede_cause = 'conflict-resolution'
  WHERE rowid IN (SELECT rowid ${CONFLICT_RESOLUTION_SUPERSEDED_AS_OTHER});
`;

const CREATE_RISK_GRADES = `
  CREATE TABLE IF NOT EXISTS risk_grades (
    repository    TEXT NOT NULL,
    number        INTEGER NOT NULL,
    head_sha      TEXT NOT NULL,
    fingerprint   TEXT NOT NULL,
    model         TEXT NOT NULL,
    probabilities TEXT NOT NULL,
    score         REAL NOT NULL,
    confidence    REAL NOT NULL,
    level         TEXT NOT NULL,
    uncertain     INTEGER NOT NULL,
    cost_usd      REAL NOT NULL,
    graded_at     TEXT NOT NULL,
    check_posted  INTEGER NOT NULL DEFAULT 0,
    outcome       TEXT NOT NULL DEFAULT 'open',
    outcome_at    TEXT,
    revisions     INTEGER,
    supersede_cause TEXT,
    PRIMARY KEY (repository, number, head_sha)
  ) STRICT;
`;

const CREATE_GRADING_ATTEMPTS = `
  CREATE TABLE IF NOT EXISTS grading_attempts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    repository   TEXT NOT NULL,
    number       INTEGER NOT NULL,
    head_sha     TEXT NOT NULL,
    attempted_at TEXT NOT NULL,
    category     TEXT NOT NULL,
    message      TEXT NOT NULL,
    check_posted INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE INDEX IF NOT EXISTS grading_attempts_head
    ON grading_attempts (repository, number, head_sha);
`;

const HAS_GRADE_LABELS = `
  SELECT 1 FROM pragma_table_info('risk_grades') WHERE name = 'labels_applied'
`;

const ADD_GRADE_LABELS = `
  ALTER TABLE risk_grades ADD COLUMN labels_applied INTEGER NOT NULL DEFAULT 0;
`;

const HAS_GRADE_UNCERTAIN = `
  SELECT 1 FROM pragma_table_info('risk_grades') WHERE name = 'uncertain'
`;

const RENAME_GRADE_UNSETTLED = `
  ALTER TABLE risk_grades RENAME COLUMN unsettled TO uncertain;
`;

const HAS_GRADE_AUTO_MERGE_STARTED = `
  SELECT 1 FROM pragma_table_info('risk_grades') WHERE name = 'auto_merge_started_at'
`;

const ADD_GRADE_AUTO_MERGE_STARTED = `
  ALTER TABLE risk_grades ADD COLUMN auto_merge_started_at TEXT;
`;

const HAS_RISK_GRADE_OUTCOME = `
  SELECT 1 FROM pragma_table_info('risk_grades') WHERE name = 'outcome'
`;

const ADD_RISK_GRADE_OUTCOME = `
  ALTER TABLE risk_grades ADD COLUMN outcome TEXT NOT NULL DEFAULT 'open';
  ALTER TABLE risk_grades ADD COLUMN outcome_at TEXT;
  ALTER TABLE risk_grades ADD COLUMN revisions INTEGER;
`;

export const migrateGrades = (connection: Connection): void => {
  connection.exec(CREATE_RISK_GRADES);
  connection.exec(CREATE_GRADING_ATTEMPTS);
  addColumnsOnce(connection, HAS_GRADE_LABELS, ADD_GRADE_LABELS);
  addColumnsOnce(connection, HAS_RISK_GRADE_OUTCOME, ADD_RISK_GRADE_OUTCOME);
  addColumnsOnce(connection, HAS_GRADE_AUTO_MERGE_STARTED, ADD_GRADE_AUTO_MERGE_STARTED);
  addColumnsOnce(connection, HAS_GRADE_SUPERSEDE_CAUSE, ADD_GRADE_SUPERSEDE_CAUSE);
  addColumnsOnce(connection, HAS_GRADE_UNCERTAIN, RENAME_GRADE_UNSETTLED);
  migrateWhenNeeded(connection, HAS_MISATTRIBUTED_CONFLICT_RESOLUTION_SUPERSEDE, CORRECT_CONFLICT_RESOLUTION_SUPERSEDES);
};
