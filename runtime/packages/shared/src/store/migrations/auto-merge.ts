import type { Connection } from '../connection.ts';

const CREATE_PULL_REQUEST_HOLDS = `
  CREATE TABLE IF NOT EXISTS pull_request_holds (
    repository TEXT NOT NULL,
    number     INTEGER NOT NULL,
    PRIMARY KEY (repository, number)
  );
`;

const CREATE_AUTO_MERGE_SAMPLES = `
  CREATE TABLE IF NOT EXISTS auto_merge_samples (
    repository TEXT NOT NULL,
    number     INTEGER NOT NULL,
    sampled    INTEGER NOT NULL,
    drawn_at   TEXT NOT NULL,
    announced  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (repository, number)
  );
`;

const CREATE_AUTO_MERGE_VERDICTS = `
  CREATE TABLE IF NOT EXISTS auto_merge_verdicts (
    repository   TEXT NOT NULL,
    number       INTEGER NOT NULL,
    head_sha     TEXT NOT NULL,
    verdict      TEXT NOT NULL,
    conclusion   TEXT NOT NULL,
    check_run_id INTEGER NOT NULL,
    PRIMARY KEY (repository, number, head_sha)
  ) STRICT;
`;

export const migrateAutoMerge = (connection: Connection): void => {
  connection.exec(CREATE_PULL_REQUEST_HOLDS);
  connection.exec(CREATE_AUTO_MERGE_SAMPLES);
  connection.exec(CREATE_AUTO_MERGE_VERDICTS);
};
