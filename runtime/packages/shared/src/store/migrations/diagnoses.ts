import type { Connection } from '../connection.ts';
import { addColumnsOnce } from './steps.ts';

const HAS_DIAGNOSIS_START = `
  SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'diagnosis_start'
`;

const CREATE_DIAGNOSES = `
  CREATE TABLE IF NOT EXISTS diagnoses (
    id            INTEGER PRIMARY KEY,
    run_id        TEXT NOT NULL UNIQUE,
    failed_run_id TEXT NOT NULL,
    state         TEXT NOT NULL,
    category      TEXT,
    evidence      TEXT,
    suggested_fix TEXT,
    detail        TEXT,
    started_at    TEXT NOT NULL,
    alive_at      TEXT NOT NULL,
    ended_at      TEXT
  ) STRICT;

  CREATE INDEX IF NOT EXISTS diagnoses_failed_run ON diagnoses (failed_run_id, id);
`;

const CREATE_DIAGNOSIS_START = `
  CREATE TABLE IF NOT EXISTS diagnosis_start (
    started_at TEXT NOT NULL
  ) STRICT;
`;

export const migrateDiagnoses = (connection: Connection): void => {
  addColumnsOnce(connection, HAS_DIAGNOSIS_START, `${CREATE_DIAGNOSES}${CREATE_DIAGNOSIS_START}`);
};
