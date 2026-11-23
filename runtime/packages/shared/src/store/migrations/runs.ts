import type { Connection } from '../connection.ts';
import { addColumnsOnce, migrateWhenNeeded } from './steps.ts';

export const GIVEN_UP_ESTIMATE = `(
  SELECT COALESCE(SUM(estimated_cost_usd), 0) FROM generations
  WHERE run_id = runs.id AND billed_cost_usd IS NULL AND given_up_at IS NOT NULL
)`;

const CREATE_RUNS = `
  CREATE TABLE IF NOT EXISTS runs (
    id             TEXT PRIMARY KEY,
    worker         TEXT NOT NULL,
    harness        TEXT NOT NULL,
    model          TEXT NOT NULL,
    start_time     TEXT NOT NULL,
    end_time       TEXT,
    status         TEXT NOT NULL,
    cost_status    TEXT NOT NULL,
    cost_usd       REAL NOT NULL,
    input_tokens   INTEGER NOT NULL,
    output_tokens  INTEGER NOT NULL,
    transcript_ref TEXT,
    session_id     TEXT,
    error          TEXT,
    repository     TEXT,
    ticket_number  INTEGER,
    ticket_url     TEXT,
    cache_read_tokens  INTEGER,
    cache_write_tokens INTEGER,
    cost_estimated     INTEGER NOT NULL DEFAULT 0,
    unconfirmed_estimate_usd REAL NOT NULL DEFAULT 0,
    input_price        REAL,
    output_price       REAL,
    cache_read_price   REAL,
    cache_write_price  REAL,
    reasoning_effort   TEXT,
    alive_at           TEXT,
    harness_start_time TEXT,
    timeout_seconds    INTEGER,
    exceeded_limit     TEXT,
    max_cost_usd       REAL,
    fingerprint        TEXT,
    fingerprint_hash   TEXT,
    forge_git_sha      TEXT,
    base_commit        TEXT,
    tool_calls          INTEGER,
    failed_tool_results INTEGER,
    retries             INTEGER,
    compactions         INTEGER
  ) STRICT;
`;

const HAS_RUN_TICKET = `
  SELECT 1 FROM pragma_table_info('runs') WHERE name = 'ticket_number'
`;

const ADD_RUN_TICKET = `
  ALTER TABLE runs ADD COLUMN repository TEXT;
  ALTER TABLE runs ADD COLUMN ticket_number INTEGER;
  ALTER TABLE runs ADD COLUMN ticket_url TEXT;
`;

const HAS_RUN_CACHE_TOKENS = `
  SELECT 1 FROM pragma_table_info('runs') WHERE name = 'cache_read_tokens'
`;

const ADD_RUN_CACHE_TOKENS = `
  ALTER TABLE runs ADD COLUMN cache_read_tokens INTEGER;
  ALTER TABLE runs ADD COLUMN cache_write_tokens INTEGER;
`;

const HAS_RUN_ESTIMATE = `
  SELECT 1 FROM pragma_table_info('runs') WHERE name = 'cost_estimated'
`;

const ADD_RUN_ESTIMATE = `
  ALTER TABLE runs ADD COLUMN cost_estimated INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE runs ADD COLUMN input_price REAL;
  ALTER TABLE runs ADD COLUMN output_price REAL;
  ALTER TABLE runs ADD COLUMN cache_read_price REAL;
  ALTER TABLE runs ADD COLUMN cache_write_price REAL;
`;

const HAS_RUN_UNCONFIRMED_ESTIMATE = `
  SELECT 1 FROM pragma_table_info('runs') WHERE name = 'unconfirmed_estimate_usd'
`;

const ADD_RUN_UNCONFIRMED_ESTIMATE = `
  ALTER TABLE runs ADD COLUMN unconfirmed_estimate_usd REAL NOT NULL DEFAULT 0;
  UPDATE runs SET unconfirmed_estimate_usd = ${GIVEN_UP_ESTIMATE};
`;

const HAS_RUN_EFFORT = `
  SELECT 1 FROM pragma_table_info('runs') WHERE name = 'reasoning_effort'
`;

const ADD_RUN_EFFORT = `
  ALTER TABLE runs ADD COLUMN reasoning_effort TEXT;
`;

const HAS_RUN_HEARTBEAT = `
  SELECT 1 FROM pragma_table_info('runs') WHERE name = 'alive_at'
`;

const ADD_RUN_HEARTBEAT = `
  ALTER TABLE runs ADD COLUMN alive_at TEXT;
`;

const HAS_RUN_LIMITS = `
  SELECT 1 FROM pragma_table_info('runs') WHERE name = 'exceeded_limit'
`;

const ADD_RUN_LIMITS = `
  ALTER TABLE runs ADD COLUMN harness_start_time TEXT;
  ALTER TABLE runs ADD COLUMN timeout_seconds INTEGER;
  ALTER TABLE runs ADD COLUMN exceeded_limit TEXT;
`;

const HAS_RUN_FINGERPRINT = `
  SELECT 1 FROM pragma_table_info('runs') WHERE name = 'fingerprint'
`;

const ADD_RUN_FINGERPRINT = `
  ALTER TABLE runs ADD COLUMN fingerprint TEXT;
  ALTER TABLE runs ADD COLUMN fingerprint_hash TEXT;
  ALTER TABLE runs ADD COLUMN forge_git_sha TEXT;
  ALTER TABLE runs ADD COLUMN base_commit TEXT;
`;

const HAS_RUN_BUDGET = `
  SELECT 1 FROM pragma_table_info('runs') WHERE name = 'max_cost_usd'
`;

const ADD_RUN_BUDGET = `
  ALTER TABLE runs ADD COLUMN max_cost_usd REAL;
`;

const HAS_RUN_COUNTERS = `
  SELECT 1 FROM pragma_table_info('runs') WHERE name = 'tool_calls'
`;

const ADD_RUN_COUNTERS = `
  ALTER TABLE runs ADD COLUMN tool_calls INTEGER;
  ALTER TABLE runs ADD COLUMN failed_tool_results INTEGER;
  ALTER TABLE runs ADD COLUMN retries INTEGER;
  ALTER TABLE runs ADD COLUMN compactions INTEGER;
`;

const CREATE_GENERATIONS = `
  CREATE TABLE IF NOT EXISTS generations (
    id              INTEGER PRIMARY KEY,
    run_id          TEXT NOT NULL,
    generation_id   TEXT,
    subagent        TEXT,
    billed_cost_usd REAL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT,
    last_error      TEXT,
    given_up_at     TEXT,
    created_at      TEXT NOT NULL,
    input_tokens       INTEGER,
    output_tokens      INTEGER,
    cache_read_tokens  INTEGER,
    cache_write_tokens INTEGER,
    reasoning_tokens   INTEGER,
    provider           TEXT,
    estimated_cost_usd REAL,
    list_price_equivalent_usd REAL,
    served_model       TEXT,
    kind               TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'compaction', 'cache_warm')),
    UNIQUE (run_id, generation_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS generations_unsettled ON generations (id)
    WHERE billed_cost_usd IS NULL AND given_up_at IS NULL;
`;

const HAS_GENERATION_TOKENS = `
  SELECT 1 FROM pragma_table_info('generations') WHERE name = 'input_tokens'
`;

const ADD_GENERATION_TOKENS = `
  ALTER TABLE generations ADD COLUMN input_tokens INTEGER;
  ALTER TABLE generations ADD COLUMN output_tokens INTEGER;
  ALTER TABLE generations ADD COLUMN cache_read_tokens INTEGER;
  ALTER TABLE generations ADD COLUMN cache_write_tokens INTEGER;
`;

const HAS_GENERATION_BILLING = `
  SELECT 1 FROM pragma_table_info('generations') WHERE name = 'provider'
`;

const ADD_GENERATION_BILLING = `
  ALTER TABLE generations ADD COLUMN reasoning_tokens INTEGER;
  ALTER TABLE generations ADD COLUMN provider TEXT;
`;

const HAS_GENERATION_ESTIMATE = `
  SELECT 1 FROM pragma_table_info('generations') WHERE name = 'estimated_cost_usd'
`;

const ADD_GENERATION_ESTIMATE = `
  ALTER TABLE generations ADD COLUMN estimated_cost_usd REAL;
`;

const HAS_GENERATION_LIST_PRICE_EQUIVALENT = `
  SELECT 1 FROM pragma_table_info('generations') WHERE name = 'list_price_equivalent_usd'
`;

const ADD_GENERATION_LIST_PRICE_EQUIVALENT = `
  ALTER TABLE generations ADD COLUMN list_price_equivalent_usd REAL;
`;

const HAS_GENERATION_SERVED_MODEL = `
  SELECT 1 FROM pragma_table_info('generations') WHERE name = 'served_model'
`;

const ADD_GENERATION_SERVED_MODEL = `
  ALTER TABLE generations ADD COLUMN served_model TEXT;
`;

const HAS_GENERATION_KIND = `
  SELECT 1 FROM pragma_table_info('generations') WHERE name = 'kind'
`;

const ADD_GENERATION_KIND = `
  ALTER TABLE generations ADD COLUMN kind TEXT NOT NULL DEFAULT 'message'
    CHECK (kind IN ('message', 'compaction', 'cache_warm'));
`;

const CREATE_SKILL_LOADS = `
  CREATE TABLE IF NOT EXISTS skill_loads (
    run_id    TEXT NOT NULL,
    subagent  TEXT NOT NULL,
    skill     TEXT NOT NULL,
    source    TEXT NOT NULL,
    loaded_at TEXT NOT NULL,
    PRIMARY KEY (run_id, subagent, skill)
  ) STRICT;
`;

const HAS_SKILL_LOAD_COVERAGE = `
  SELECT 1 FROM pragma_table_info('skill_loads') WHERE name = 'lines_covered'
`;

const ADD_SKILL_LOAD_COVERAGE = `
  ALTER TABLE skill_loads ADD COLUMN lines_covered INTEGER;
  ALTER TABLE skill_loads ADD COLUMN total_lines INTEGER;
`;

const HAS_RUN_SKILL_LOADS_RECORDED = `
  SELECT 1 FROM pragma_table_info('runs') WHERE name = 'skill_loads_recorded'
`;

const ADD_RUN_SKILL_LOADS_RECORDED = `
  ALTER TABLE runs ADD COLUMN skill_loads_recorded INTEGER;
  UPDATE runs SET skill_loads_recorded = 1
    WHERE id IN (SELECT run_id FROM skill_loads);
`;

const HAS_COST_UNCERTAIN = `
  SELECT 1 FROM pragma_table_info('runs') WHERE name = 'cost_uncertain'
`;

const MIGRATE_COST_UNCERTAIN = `
  ALTER TABLE runs RENAME TO runs_cost_uncertain;
  ${CREATE_RUNS}
  INSERT INTO runs (
    id, worker, harness, model, start_time, end_time, status,
    cost_status, cost_usd, input_tokens, output_tokens,
    transcript_ref, session_id, error
  )
  SELECT
    id, worker, harness, model, start_time, end_time, status,
    CASE WHEN cost_uncertain = 0 AND status != 'running' THEN 'billed' ELSE 'unconfirmed' END,
    cost_usd, input_tokens, output_tokens,
    transcript_ref, session_id, error
  FROM runs_cost_uncertain;
  DROP TABLE runs_cost_uncertain;
`;

export const migrateRuns = (connection: Connection): void => {
  migrateWhenNeeded(connection, HAS_COST_UNCERTAIN, MIGRATE_COST_UNCERTAIN);
  connection.exec(CREATE_RUNS);
  addColumnsOnce(connection, HAS_RUN_TICKET, ADD_RUN_TICKET);
  addColumnsOnce(connection, HAS_RUN_CACHE_TOKENS, ADD_RUN_CACHE_TOKENS);
  addColumnsOnce(connection, HAS_RUN_ESTIMATE, ADD_RUN_ESTIMATE);
  addColumnsOnce(connection, HAS_RUN_EFFORT, ADD_RUN_EFFORT);
  addColumnsOnce(connection, HAS_RUN_HEARTBEAT, ADD_RUN_HEARTBEAT);
  addColumnsOnce(connection, HAS_RUN_LIMITS, ADD_RUN_LIMITS);
  addColumnsOnce(connection, HAS_RUN_BUDGET, ADD_RUN_BUDGET);
  addColumnsOnce(connection, HAS_RUN_FINGERPRINT, ADD_RUN_FINGERPRINT);
  addColumnsOnce(connection, HAS_RUN_COUNTERS, ADD_RUN_COUNTERS);
  connection.exec(CREATE_GENERATIONS);
  connection.exec(CREATE_SKILL_LOADS);
  addColumnsOnce(connection, HAS_SKILL_LOAD_COVERAGE, ADD_SKILL_LOAD_COVERAGE);
  addColumnsOnce(connection, HAS_RUN_SKILL_LOADS_RECORDED, ADD_RUN_SKILL_LOADS_RECORDED);
  addColumnsOnce(connection, HAS_GENERATION_TOKENS, ADD_GENERATION_TOKENS);
  addColumnsOnce(connection, HAS_GENERATION_BILLING, ADD_GENERATION_BILLING);
  addColumnsOnce(connection, HAS_GENERATION_ESTIMATE, ADD_GENERATION_ESTIMATE);
  addColumnsOnce(connection, HAS_GENERATION_LIST_PRICE_EQUIVALENT, ADD_GENERATION_LIST_PRICE_EQUIVALENT);
  addColumnsOnce(connection, HAS_GENERATION_SERVED_MODEL, ADD_GENERATION_SERVED_MODEL);
  addColumnsOnce(connection, HAS_GENERATION_KIND, ADD_GENERATION_KIND);
  addColumnsOnce(connection, HAS_RUN_UNCONFIRMED_ESTIMATE, ADD_RUN_UNCONFIRMED_ESTIMATE);
};
