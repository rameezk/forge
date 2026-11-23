import type { Connection } from '../connection.ts';
import { migrateWhenNeeded } from './steps.ts';

const CREATE_FRONTIER = `
  CREATE TABLE IF NOT EXISTS frontier_repositories (
    repository   TEXT PRIMARY KEY,
    github       TEXT NOT NULL,
    polled_at    TEXT,
    last_error   TEXT,
    failed_at    TEXT,
    branch_rules TEXT,
    own_branch_rules TEXT
  ) STRICT;

  CREATE TABLE IF NOT EXISTS frontier_tickets (
    repository    TEXT NOT NULL REFERENCES frontier_repositories (repository) ON DELETE CASCADE,
    number        INTEGER NOT NULL,
    title         TEXT NOT NULL,
    url           TEXT NOT NULL,
    parent_number INTEGER,
    parent_title  TEXT,
    parent_url    TEXT,
    created_at    TEXT NOT NULL,
    forge_ready   INTEGER NOT NULL,
    for_human     INTEGER NOT NULL,
    blocked       INTEGER NOT NULL,
    blocked_by    TEXT NOT NULL,
    version       TEXT NOT NULL DEFAULT '',
    awaiting_redispatch INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (repository, number)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS frontier_closed (
    repository    TEXT NOT NULL REFERENCES frontier_repositories (repository) ON DELETE CASCADE,
    number        INTEGER NOT NULL,
    title         TEXT NOT NULL,
    url           TEXT NOT NULL,
    parent_number INTEGER,
    parent_title  TEXT,
    parent_url    TEXT,
    created_at    TEXT NOT NULL,
    closed_at     TEXT NOT NULL,
    for_human     INTEGER NOT NULL,
    PRIMARY KEY (repository, number)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS frontier_requests (
    repository TEXT NOT NULL REFERENCES frontier_repositories (repository) ON DELETE CASCADE,
    number     INTEGER NOT NULL,
    title      TEXT NOT NULL,
    url        TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (repository, number)
  ) STRICT;
`;

const CREATE_REVIEWER_APP_CHECKS = `
  CREATE TABLE IF NOT EXISTS reviewer_app_checks (
    repository TEXT PRIMARY KEY,
    failures   TEXT NOT NULL,
    checked_at TEXT NOT NULL
  ) STRICT;
`;

const HAS_OUTDATED_FRONTIER = `
  SELECT 1 FROM sqlite_master
  WHERE (
    type = 'table' AND name = 'frontier_repositories'
    AND NOT EXISTS (
      SELECT 1 FROM pragma_table_info('frontier_repositories') WHERE name = 'own_branch_rules'
    )
  ) OR (
    type = 'table' AND name = 'frontier_tickets'
    AND NOT EXISTS (
      SELECT 1 FROM pragma_table_info('frontier_tickets') WHERE name = 'version'
    )
  ) OR (
    type = 'table' AND name = 'frontier_tickets'
    AND NOT EXISTS (
      SELECT 1 FROM pragma_table_info('frontier_tickets') WHERE name = 'awaiting_redispatch'
    )
  )
`;

const DROP_FRONTIER = `
  DROP TABLE frontier_tickets;
  DROP TABLE frontier_repositories;
`;

export const migrateFrontier = (connection: Connection): void => {
  migrateWhenNeeded(connection, HAS_OUTDATED_FRONTIER, `${DROP_FRONTIER}${CREATE_FRONTIER}`);
  connection.exec(CREATE_FRONTIER);
  connection.exec(CREATE_REVIEWER_APP_CHECKS);
};
