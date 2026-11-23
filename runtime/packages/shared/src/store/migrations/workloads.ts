import type { Connection } from '../connection.ts';
import { addColumnsOnce, migrateWhenNeeded } from './steps.ts';

const HAS_DISPATCH_PULL_REQUEST = `
  SELECT 1 FROM pragma_table_info('dispatches') WHERE name = 'pr_number'
`;

const ADD_DISPATCH_PULL_REQUEST = `
  ALTER TABLE dispatches ADD COLUMN pr_number INTEGER;
  ALTER TABLE dispatches ADD COLUMN pr_url TEXT;
  ALTER TABLE dispatches ADD COLUMN pr_state TEXT;
  ALTER TABLE dispatches ADD COLUMN pr_settled_at TEXT;
  ALTER TABLE dispatches ADD COLUMN pr_rework INTEGER;
`;

const HAS_DISPATCH_FAILED_STARTS = `
  SELECT 1 FROM pragma_table_info('dispatches') WHERE name = 'failed_starts'
`;

const ADD_DISPATCH_FAILED_STARTS = `
  ALTER TABLE dispatches ADD COLUMN failed_starts INTEGER;
`;

const CREATE_DISPATCHES = `
  CREATE TABLE IF NOT EXISTS dispatches (
    id         INTEGER PRIMARY KEY,
    repository TEXT NOT NULL,
    number     INTEGER NOT NULL,
    url        TEXT NOT NULL,
    run_id     TEXT,
    state      TEXT NOT NULL,
    reason     TEXT,
    detail     TEXT,
    started_at TEXT NOT NULL,
    alive_at   TEXT NOT NULL,
    ended_at   TEXT
  ) STRICT;

  CREATE INDEX IF NOT EXISTS dispatches_ticket ON dispatches (repository, number, id);
`;

const CREATE_REVISIONS = `
  CREATE TABLE IF NOT EXISTS revisions (
    id              INTEGER PRIMARY KEY,
    repository      TEXT NOT NULL,
    number          INTEGER NOT NULL,
    url             TEXT NOT NULL,
    run_id          TEXT,
    dispatch_id     INTEGER,
    state           TEXT NOT NULL,
    reason          TEXT,
    detail          TEXT,
    failed_starts   INTEGER,
    started_at      TEXT NOT NULL,
    alive_at        TEXT NOT NULL,
    ended_at        TEXT,
    feedback_cursor TEXT,
    pushed_sha      TEXT
  ) STRICT;

  CREATE INDEX IF NOT EXISTS revisions_pull_request ON revisions (repository, number, id);
  CREATE UNIQUE INDEX IF NOT EXISTS revisions_run ON revisions (run_id);
`;

const HAS_REVISION_FAILURE = `
  SELECT 1 FROM pragma_table_info('revisions') WHERE name = 'reason'
`;

const ADD_REVISION_FAILURE = `
  ALTER TABLE revisions ADD COLUMN reason TEXT;
  ALTER TABLE revisions ADD COLUMN detail TEXT;
`;

const HAS_REVISION_FAILED_STARTS = `
  SELECT 1 FROM pragma_table_info('revisions') WHERE name = 'failed_starts'
`;

const ADD_REVISION_FAILED_STARTS = `
  ALTER TABLE revisions ADD COLUMN failed_starts INTEGER;
`;

const HAS_REVISION_OPTIONAL_RUN = `
  SELECT 1 FROM pragma_table_info('revisions') WHERE name = 'run_id' AND "notnull" = 0
`;

const MIGRATE_REVISION_RUN = `
  ALTER TABLE revisions RENAME TO revisions_required_run;
  DROP INDEX revisions_pull_request;
  DROP INDEX revisions_run;
  ${CREATE_REVISIONS}
  INSERT INTO revisions (
    id, repository, number, url, run_id, dispatch_id, state, reason, detail, failed_starts,
    started_at, alive_at, ended_at, feedback_cursor
  )
  SELECT
    id, repository, number, url, run_id, dispatch_id, state, reason, detail, failed_starts,
    started_at, alive_at, ended_at, feedback_cursor
  FROM revisions_required_run;
  DROP TABLE revisions_required_run;
`;

const CREATE_CONFLICT_RESOLUTIONS = `
  CREATE TABLE IF NOT EXISTS conflict_resolutions (
    id            INTEGER PRIMARY KEY,
    repository    TEXT NOT NULL,
    number        INTEGER NOT NULL,
    url           TEXT NOT NULL,
    run_id        TEXT,
    dispatch_id   INTEGER,
    state         TEXT NOT NULL,
    reason        TEXT,
    detail        TEXT,
    failed_starts INTEGER,
    started_at    TEXT NOT NULL,
    alive_at      TEXT NOT NULL,
    ended_at      TEXT,
    head_sha      TEXT,
    default_sha   TEXT,
    pushed_sha    TEXT
  ) STRICT;

  CREATE INDEX IF NOT EXISTS conflict_resolutions_pull_request ON conflict_resolutions (repository, number, id);
  CREATE UNIQUE INDEX IF NOT EXISTS conflict_resolutions_run ON conflict_resolutions (run_id);
`;

const HAS_CONFLICT_RESOLUTION_FAILED_STARTS = `
  SELECT 1 FROM pragma_table_info('conflict_resolutions') WHERE name = 'failed_starts'
`;

const ADD_CONFLICT_RESOLUTION_FAILED_STARTS = `
  ALTER TABLE conflict_resolutions ADD COLUMN failed_starts INTEGER;
`;

const HAS_CONFLICT_RESOLUTION_OPTIONAL_RUN = `
  SELECT 1 FROM pragma_table_info('conflict_resolutions') WHERE name = 'run_id' AND "notnull" = 0
`;

const MIGRATE_CONFLICT_RESOLUTION_RUN = `
  ALTER TABLE conflict_resolutions RENAME TO conflict_resolutions_required_run;
  DROP INDEX conflict_resolutions_pull_request;
  DROP INDEX conflict_resolutions_run;
  ${CREATE_CONFLICT_RESOLUTIONS}
  INSERT INTO conflict_resolutions (
    id, repository, number, url, run_id, dispatch_id, state, reason, detail, failed_starts,
    started_at, alive_at, ended_at, head_sha, default_sha
  )
  SELECT
    id, repository, number, url, run_id, dispatch_id, state, reason, detail, failed_starts,
    started_at, alive_at, ended_at, head_sha, default_sha
  FROM conflict_resolutions_required_run;
  DROP TABLE conflict_resolutions_required_run;
`;

const HAS_CONFLICT_RESOLUTION_DISPATCH = `
  SELECT 1 FROM pragma_table_info('conflict_resolutions') WHERE name = 'dispatch_id'
`;

const ADD_CONFLICT_RESOLUTION_DISPATCH = `
  ALTER TABLE conflict_resolutions ADD COLUMN dispatch_id INTEGER;
`;

const OLD_WORKLOAD_TABLES = ['revisions', 'conflict_resolutions'];

const HAS_OLD_WORKLOAD_STATES = `
  SELECT 1 WHERE ${OLD_WORKLOAD_TABLES.map(
    (table) => `EXISTS (SELECT 1 FROM ${table} WHERE state IN ('ok', 'error', 'exceeded', 'interrupted'))`,
  ).join(' OR ')}
`;

const MIGRATE_WORKLOAD_STATES = OLD_WORKLOAD_TABLES.map(
  (table) => `
  UPDATE ${table} SET
    reason = CASE state WHEN 'exceeded' THEN 'exceeded' WHEN 'interrupted' THEN 'interrupted' ELSE reason END,
    detail = CASE WHEN state = 'exceeded' AND detail IS NULL
      THEN (SELECT exceeded_limit FROM runs WHERE runs.id = ${table}.run_id)
      ELSE detail END,
    state = CASE state WHEN 'ok' THEN 'done' ELSE 'failed' END
  WHERE state IN ('ok', 'error', 'exceeded', 'interrupted');
`,
).join('');

const HAS_REVISION_FEEDBACK_CURSOR = `
  SELECT 1 FROM pragma_table_info('revisions') WHERE name = 'feedback_cursor'
`;

const ADD_REVISION_FEEDBACK_CURSOR = `
  ALTER TABLE revisions ADD COLUMN feedback_cursor TEXT;
`;

const HAS_CONFLICT_RESOLUTION_SHAS = `
  SELECT 1 FROM pragma_table_info('conflict_resolutions') WHERE name = 'head_sha'
`;

const ADD_CONFLICT_RESOLUTION_SHAS = `
  ALTER TABLE conflict_resolutions ADD COLUMN head_sha TEXT;
  ALTER TABLE conflict_resolutions ADD COLUMN default_sha TEXT;
`;

const HAS_REVISION_PUSHED_SHA = `
  SELECT 1 FROM pragma_table_info('revisions') WHERE name = 'pushed_sha'
`;

const ADD_REVISION_PUSHED_SHA = `
  ALTER TABLE revisions ADD COLUMN pushed_sha TEXT;
`;

const HAS_CONFLICT_RESOLUTION_PUSHED_SHA = `
  SELECT 1 FROM pragma_table_info('conflict_resolutions') WHERE name = 'pushed_sha'
`;

const ADD_CONFLICT_RESOLUTION_PUSHED_SHA = `
  ALTER TABLE conflict_resolutions ADD COLUMN pushed_sha TEXT;
`;

const HAS_WATCH_MERGEABLE = `
  SELECT 1 FROM pragma_table_info('feedback_watches') WHERE name = 'mergeable'
`;

const ADD_WATCH_MERGEABLE = `
  ALTER TABLE feedback_watches ADD COLUMN mergeable TEXT;
  ALTER TABLE feedback_watches ADD COLUMN head_sha TEXT;
  ALTER TABLE feedback_watches ADD COLUMN default_sha TEXT;
`;

const HAS_WATCH_HELD = `
  SELECT 1 FROM pragma_table_info('feedback_watches') WHERE name = 'held'
`;

const ADD_WATCH_HELD = `
  ALTER TABLE feedback_watches ADD COLUMN held TEXT;
`;

const HAS_WATCH_DRAFT = `
  SELECT 1 FROM pragma_table_info('feedback_watches') WHERE name = 'draft'
`;

const ADD_WATCH_DRAFT = `
  ALTER TABLE feedback_watches ADD COLUMN draft INTEGER;
`;

const CREATE_FEEDBACK_WATCHES = `
  CREATE TABLE IF NOT EXISTS feedback_watches (
    repository TEXT NOT NULL,
    number     INTEGER NOT NULL,
    url        TEXT NOT NULL,
    closes     TEXT NOT NULL,
    cursor     TEXT,
    newest     TEXT,
    PRIMARY KEY (repository, number)
  ) STRICT;
`;

export const migrateWorkloads = (connection: Connection): void => {
  connection.exec(CREATE_DISPATCHES);
  connection.exec(CREATE_REVISIONS);
  addColumnsOnce(connection, HAS_REVISION_FAILURE, ADD_REVISION_FAILURE);
  connection.exec(CREATE_CONFLICT_RESOLUTIONS);
  addColumnsOnce(connection, HAS_CONFLICT_RESOLUTION_DISPATCH, ADD_CONFLICT_RESOLUTION_DISPATCH);
  addColumnsOnce(connection, HAS_REVISION_FEEDBACK_CURSOR, ADD_REVISION_FEEDBACK_CURSOR);
  addColumnsOnce(connection, HAS_REVISION_FAILED_STARTS, ADD_REVISION_FAILED_STARTS);
  addColumnsOnce(connection, HAS_REVISION_OPTIONAL_RUN, MIGRATE_REVISION_RUN);
  connection.exec(CREATE_FEEDBACK_WATCHES);
  addColumnsOnce(connection, HAS_WATCH_HELD, ADD_WATCH_HELD);
  addColumnsOnce(connection, HAS_WATCH_DRAFT, ADD_WATCH_DRAFT);
  addColumnsOnce(connection, HAS_CONFLICT_RESOLUTION_SHAS, ADD_CONFLICT_RESOLUTION_SHAS);
  addColumnsOnce(connection, HAS_WATCH_MERGEABLE, ADD_WATCH_MERGEABLE);
  addColumnsOnce(connection, HAS_DISPATCH_PULL_REQUEST, ADD_DISPATCH_PULL_REQUEST);
  addColumnsOnce(connection, HAS_DISPATCH_FAILED_STARTS, ADD_DISPATCH_FAILED_STARTS);
  addColumnsOnce(connection, HAS_CONFLICT_RESOLUTION_FAILED_STARTS, ADD_CONFLICT_RESOLUTION_FAILED_STARTS);
  addColumnsOnce(connection, HAS_CONFLICT_RESOLUTION_OPTIONAL_RUN, MIGRATE_CONFLICT_RESOLUTION_RUN);
  addColumnsOnce(connection, HAS_REVISION_PUSHED_SHA, ADD_REVISION_PUSHED_SHA);
  addColumnsOnce(connection, HAS_CONFLICT_RESOLUTION_PUSHED_SHA, ADD_CONFLICT_RESOLUTION_PUSHED_SHA);
  migrateWhenNeeded(connection, HAS_OLD_WORKLOAD_STATES, MIGRATE_WORKLOAD_STATES);
};
