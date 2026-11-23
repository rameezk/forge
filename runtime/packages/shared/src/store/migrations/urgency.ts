import type { Connection } from '../connection.ts';

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
