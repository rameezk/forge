import { DatabaseSync } from 'node:sqlite';
import {
  oldestFirst,
  type PolledFrontier,
  type PollFailure,
  type RepositoryFrontier,
  type Ticket,
} from './frontier.ts';
import {
  DISPATCH_DETAIL_LIMIT,
  type DispatchFailure,
  type DispatchOutcome,
  type DispatchRecord,
  type DispatchStart,
  type DispatchState,
  type DispatchTicket,
  type PullRequestRecord,
  type PullRequestState,
} from './dispatch.ts';
import type {
  GenerationRecord,
  LookupResult,
  NewGeneration,
  UnsettledGeneration,
} from './generation.ts';
import { STALE_AFTER_MS } from './heartbeat.ts';
import type { RunSkillLoad } from './skill-loads.ts';
import type {
  CostStatus,
  ExceededLimit,
  InterruptedRun,
  RunRecord,
  RunResult,
  RunStatus,
} from './run.ts';

type RunRow = {
  id: string;
  worker: string;
  harness: string;
  model: string;
  reasoning_effort: string | null;
  start_time: string;
  end_time: string | null;
  status: string;
  cost_status: string;
  cost_usd: number;
  cost_estimated: number;
  input_price: number | null;
  output_price: number | null;
  cache_read_price: number | null;
  cache_write_price: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  transcript_ref: string | null;
  session_id: string | null;
  error: string | null;
  repository: string | null;
  ticket_number: number | null;
  ticket_url: string | null;
  alive_at: string | null;
  harness_start_time: string | null;
  timeout_seconds: number | null;
  max_cost_usd: number | null;
  exceeded_limit: string | null;
};

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
    input_price        REAL,
    output_price       REAL,
    cache_read_price   REAL,
    cache_write_price  REAL,
    reasoning_effort   TEXT,
    alive_at           TEXT,
    harness_start_time TEXT,
    timeout_seconds    INTEGER,
    exceeded_limit     TEXT,
    max_cost_usd       REAL
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

const HAS_RUN_BUDGET = `
  SELECT 1 FROM pragma_table_info('runs') WHERE name = 'max_cost_usd'
`;

const ADD_RUN_BUDGET = `
  ALTER TABLE runs ADD COLUMN max_cost_usd REAL;
`;

const BUSY_TIMEOUT_MS = 5000;

type GenerationRow = {
  run_id: string;
  generation_id: string | null;
  subagent: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  provider: string | null;
  served_model: string | null;
  estimated_cost_usd: number | null;
  billed_cost_usd: number | null;
  attempts: number;
  last_attempt_at: string | null;
  last_error: string | null;
  given_up_at: string | null;
  created_at: string;
};

type UnsettledRow = {
  id: number;
  run_id: string;
  generation_id: string;
  since: string;
};

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
    served_model       TEXT,
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

const HAS_GENERATION_SERVED_MODEL = `
  SELECT 1 FROM pragma_table_info('generations') WHERE name = 'served_model'
`;

const ADD_GENERATION_SERVED_MODEL = `
  ALTER TABLE generations ADD COLUMN served_model TEXT;
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

type SkillLoadRow = {
  run_id: string;
  subagent: string;
  skill: string;
  source: 'prompt' | 'read';
  loaded_at: string;
};

const NO_GENERATION_ID = 'no generation id';

const RUN_NEVER_ENDED = 'run never ended, so later generations may be unrecorded';

const stoppedWithoutFinishing = (lastSeen: string): string =>
  `runner stopped without finishing, last seen at ${lastSeen}`;

const generationSum = (column: string): string =>
  `${column} = COALESCE(
    (SELECT MIN(SUM(${column}), ${Number.MAX_SAFE_INTEGER}) FROM generations WHERE run_id = runs.id),
    ${column}
  )`;

const AWAITING_BILLING = `
  run_id = runs.id AND billed_cost_usd IS NULL AND given_up_at IS NULL
`;

const FULLY_ESTIMATED = `(
  EXISTS (SELECT 1 FROM generations WHERE ${AWAITING_BILLING})
  AND NOT EXISTS (
    SELECT 1 FROM generations WHERE ${AWAITING_BILLING} AND estimated_cost_usd IS NULL
  )
)`;

const SETTLE_RUN = `
  UPDATE runs SET
    ${generationSum('input_tokens')},
    ${generationSum('output_tokens')},
    ${generationSum('cache_read_tokens')},
    ${generationSum('cache_write_tokens')},
    cost_usd = (
      SELECT COALESCE(SUM(billed_cost_usd), 0) FROM generations WHERE run_id = runs.id
    ) + CASE WHEN ${FULLY_ESTIMATED} THEN (
      SELECT SUM(estimated_cost_usd) FROM generations WHERE ${AWAITING_BILLING}
    ) ELSE 0 END,
    cost_estimated = ${FULLY_ESTIMATED},
    cost_status = CASE
      WHEN EXISTS (
        SELECT 1 FROM generations WHERE run_id = runs.id AND given_up_at IS NOT NULL
      ) THEN 'unconfirmed'
      WHEN end_time IS NULL THEN 'pending'
      WHEN EXISTS (
        SELECT 1 FROM generations WHERE run_id = runs.id AND billed_cost_usd IS NULL
      ) THEN 'pending'
      ELSE 'billed'
    END
  WHERE id = $id
`;

type RepositoryRow = {
  repository: string;
  github: string;
  polled_at: string | null;
  last_error: string | null;
  failed_at: string | null;
};

type TicketRow = {
  repository: string;
  number: number;
  title: string;
  url: string;
  parent_number: number | null;
  parent_title: string | null;
  parent_url: string | null;
  created_at: string;
  forge_ready: number;
  blocked: number;
};

const CREATE_FRONTIER = `
  CREATE TABLE IF NOT EXISTS frontier_repositories (
    repository TEXT PRIMARY KEY,
    github     TEXT NOT NULL,
    polled_at  TEXT,
    last_error TEXT,
    failed_at  TEXT
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
    blocked       INTEGER NOT NULL,
    PRIMARY KEY (repository, number)
  ) STRICT;
`;

type DispatchRow = {
  id: number;
  repository: string;
  number: number;
  url: string;
  run_id: string | null;
  state: string;
  reason: string | null;
  detail: string | null;
  started_at: string;
  alive_at: string;
  ended_at: string | null;
  pr_number: number | null;
  pr_url: string | null;
  pr_state: string | null;
  pr_settled_at: string | null;
  pr_rework: number | null;
};

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

const dispatchFromRow = (row: DispatchRow): DispatchRecord => ({
  id: row.id,
  repository: row.repository,
  number: row.number,
  url: row.url,
  runId: row.run_id,
  state: row.state as DispatchState,
  reason: row.reason as DispatchFailure | null,
  detail: row.detail,
  startedAt: row.started_at,
  aliveAt: row.alive_at,
  endedAt: row.ended_at,
  pullRequest:
    row.pr_number === null || row.pr_url === null || row.pr_state === null
      ? null
      : {
          number: row.pr_number,
          url: row.pr_url,
          state: row.pr_state as PullRequestState,
          settledAt: row.pr_settled_at,
          rework: row.pr_rework,
        },
});

const boundedDetail = (detail: string | null): string | null =>
  detail === null || detail.length <= DISPATCH_DETAIL_LIMIT
    ? detail
    : `${detail.slice(0, DISPATCH_DETAIL_LIMIT - 1)}…`;

const liveSince = (now: string): string =>
  new Date(Date.parse(now) - STALE_AFTER_MS).toISOString();

const HAS_OUTDATED_FRONTIER = `
  SELECT 1 FROM sqlite_master
  WHERE (
    type = 'table' AND name = 'frontier_repositories'
    AND NOT EXISTS (
      SELECT 1 FROM pragma_table_info('frontier_repositories') WHERE name = 'failed_at'
    )
  ) OR (
    type = 'table' AND name = 'frontier_tickets'
    AND NOT EXISTS (
      SELECT 1 FROM pragma_table_info('frontier_tickets') WHERE name = 'parent_url'
    )
  )
`;

const DROP_FRONTIER = `
  DROP TABLE frontier_tickets;
  DROP TABLE frontier_repositories;
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

const toRow = (run: RunRecord): RunRow => ({
  id: run.id,
  worker: run.worker,
  harness: run.harness,
  model: run.model,
  reasoning_effort: run.reasoningEffort,
  start_time: run.startTime,
  end_time: run.endTime,
  status: run.status,
  cost_status: run.costStatus,
  cost_usd: run.costUsd,
  cost_estimated: run.costEstimated ? 1 : 0,
  input_price: run.listPrice?.input ?? null,
  output_price: run.listPrice?.output ?? null,
  cache_read_price: run.listPrice?.cacheRead ?? null,
  cache_write_price: run.listPrice?.cacheWrite ?? null,
  input_tokens: run.inputTokens,
  output_tokens: run.outputTokens,
  cache_read_tokens: run.cacheReadTokens,
  cache_write_tokens: run.cacheWriteTokens,
  transcript_ref: run.transcriptRef,
  session_id: run.sessionId,
  error: run.error,
  repository: run.ticket?.repository ?? null,
  ticket_number: run.ticket?.number ?? null,
  ticket_url: run.ticket?.url ?? null,
  alive_at: run.aliveAt,
  harness_start_time: run.harnessStartTime,
  timeout_seconds: run.timeoutSeconds,
  max_cost_usd: run.maxCostUsd,
  exceeded_limit: run.exceededLimit,
});

const ticketFromRow = (row: TicketRow): Ticket => ({
  number: row.number,
  title: row.title,
  url: row.url,
  parent:
    row.parent_number === null || row.parent_title === null || row.parent_url === null
      ? null
      : { number: row.parent_number, title: row.parent_title, url: row.parent_url },
  createdAt: row.created_at,
  forgeReady: row.forge_ready === 1,
  blocked: row.blocked === 1,
});

const generationFromRow = (row: GenerationRow): GenerationRecord => ({
  runId: row.run_id,
  generationId: row.generation_id,
  subagent: row.subagent,
  usage:
    row.input_tokens === null ||
    row.output_tokens === null ||
    row.cache_read_tokens === null ||
    row.cache_write_tokens === null
      ? null
      : {
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
          cacheReadTokens: row.cache_read_tokens,
          cacheWriteTokens: row.cache_write_tokens,
        },
  estimatedCostUsd: row.estimated_cost_usd,
  billedCostUsd: row.billed_cost_usd,
  reasoningTokens: row.reasoning_tokens,
  provider: row.provider,
  servedModel: row.served_model,
  attempts: row.attempts,
  lastAttemptAt: row.last_attempt_at,
  lastError: row.last_error,
  givenUpAt: row.given_up_at,
  createdAt: row.created_at,
});

const fromRow = (row: RunRow): RunRecord => ({
  id: row.id,
  worker: row.worker,
  harness: row.harness,
  model: row.model,
  reasoningEffort: row.reasoning_effort,
  startTime: row.start_time,
  endTime: row.end_time,
  status: row.status as RunStatus,
  costStatus: row.cost_status as CostStatus,
  costUsd: row.cost_usd,
  costEstimated: row.cost_estimated === 1,
  listPrice:
    row.input_price === null || row.output_price === null
      ? null
      : {
          input: row.input_price,
          output: row.output_price,
          cacheRead: row.cache_read_price,
          cacheWrite: row.cache_write_price,
        },
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  cacheReadTokens: row.cache_read_tokens,
  cacheWriteTokens: row.cache_write_tokens,
  transcriptRef: row.transcript_ref,
  sessionId: row.session_id,
  error: row.error,
  ticket:
    row.repository === null || row.ticket_number === null || row.ticket_url === null
      ? null
      : { repository: row.repository, number: row.ticket_number, url: row.ticket_url },
  aliveAt: row.alive_at,
  harnessStartTime: row.harness_start_time,
  timeoutSeconds: row.timeout_seconds,
  maxCostUsd: row.max_cost_usd,
  exceededLimit: row.exceeded_limit as ExceededLimit | null,
});

export interface WorkloadSpend {
  costUsd: number;
  unpriced: boolean;
}

export class Store {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
    this.#useWriteAheadLog();
    if (this.#hasCostUncertain()) {
      this.#migrateCostUncertain();
    }
    db.exec(CREATE_RUNS);
    this.#addColumnsOnce(HAS_RUN_TICKET, ADD_RUN_TICKET);
    this.#addColumnsOnce(HAS_RUN_CACHE_TOKENS, ADD_RUN_CACHE_TOKENS);
    this.#addColumnsOnce(HAS_RUN_ESTIMATE, ADD_RUN_ESTIMATE);
    this.#addColumnsOnce(HAS_RUN_EFFORT, ADD_RUN_EFFORT);
    this.#addColumnsOnce(HAS_RUN_HEARTBEAT, ADD_RUN_HEARTBEAT);
    this.#addColumnsOnce(HAS_RUN_LIMITS, ADD_RUN_LIMITS);
    this.#addColumnsOnce(HAS_RUN_BUDGET, ADD_RUN_BUDGET);
    db.exec(CREATE_GENERATIONS);
    db.exec(CREATE_SKILL_LOADS);
    this.#addColumnsOnce(HAS_GENERATION_TOKENS, ADD_GENERATION_TOKENS);
    this.#addColumnsOnce(HAS_GENERATION_BILLING, ADD_GENERATION_BILLING);
    this.#addColumnsOnce(HAS_GENERATION_ESTIMATE, ADD_GENERATION_ESTIMATE);
    this.#addColumnsOnce(HAS_GENERATION_SERVED_MODEL, ADD_GENERATION_SERVED_MODEL);
    if (this.#hasOutdatedFrontier()) {
      this.#migrateOutdatedFrontier();
    }
    db.exec(CREATE_FRONTIER);
    db.exec(CREATE_DISPATCHES);
    this.#addColumnsOnce(HAS_DISPATCH_PULL_REQUEST, ADD_DISPATCH_PULL_REQUEST);
  }

  #useWriteAheadLog(): void {
    const { journal_mode } = this.#db
      .prepare('PRAGMA journal_mode')
      .get() as { journal_mode: string };
    if (journal_mode === 'wal') {
      return;
    }
    this.#db.exec('BEGIN IMMEDIATE');
    this.#db.exec('ROLLBACK');
    this.#db.exec('PRAGMA journal_mode = WAL');
  }

  #hasOutdatedFrontier(): boolean {
    return this.#db.prepare(HAS_OUTDATED_FRONTIER).get() !== undefined;
  }

  #migrateOutdatedFrontier(): void {
    this.#transaction(() => {
      if (this.#hasOutdatedFrontier()) {
        this.#db.exec(DROP_FRONTIER);
        this.#db.exec(CREATE_FRONTIER);
      }
    });
  }

  #addColumnsOnce(present: string, add: string): void {
    const has = (): boolean => this.#db.prepare(present).get() !== undefined;
    if (has()) {
      return;
    }
    this.#transaction(() => {
      if (!has()) {
        this.#db.exec(add);
      }
    });
  }

  #hasCostUncertain(): boolean {
    return this.#db.prepare(HAS_COST_UNCERTAIN).get() !== undefined;
  }

  #migrateCostUncertain(): void {
    this.#transaction(() => {
      if (this.#hasCostUncertain()) {
        this.#db.exec(MIGRATE_COST_UNCERTAIN);
      }
    });
  }

  #transaction(work: () => void): void {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      work();
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  static open(path: string): Store {
    return new Store(new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS }));
  }

  insertRun(run: RunRecord): void {
    const row = toRow(run);
    this.#db
      .prepare(
        `INSERT INTO runs (
          id, worker, harness, model, reasoning_effort, start_time, end_time, status,
          cost_status, cost_usd, cost_estimated,
          input_price, output_price, cache_read_price, cache_write_price,
          input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens,
          transcript_ref, session_id, error,
          repository, ticket_number, ticket_url, alive_at,
          harness_start_time, timeout_seconds, exceeded_limit, max_cost_usd
        ) VALUES (
          $id, $worker, $harness, $model, $reasoning_effort, $start_time, $end_time, $status,
          $cost_status, $cost_usd, $cost_estimated,
          $input_price, $output_price, $cache_read_price, $cache_write_price,
          $input_tokens, $output_tokens,
          $cache_read_tokens, $cache_write_tokens,
          $transcript_ref, $session_id, $error,
          $repository, $ticket_number, $ticket_url, $alive_at,
          $harness_start_time, $timeout_seconds, $exceeded_limit, $max_cost_usd
        )`,
      )
      .run(row);
  }

  finalizeRun(id: string, result: RunResult): void {
    this.#transaction(() => {
      this.#db
        .prepare(
          `UPDATE runs SET
            end_time = $end_time,
            status = $status,
            session_id = $session_id,
            error = $error,
            exceeded_limit = $exceeded_limit
          WHERE id = $id`,
        )
        .run({
          id,
          end_time: result.endTime,
          status: result.status,
          session_id: result.sessionId,
          error: result.error,
          exceeded_limit: result.exceededLimit ?? null,
        });
      this.#settleRun(id);
    });
  }

  markHarnessStarted(id: string, at: string): void {
    this.#db
      .prepare(`UPDATE runs SET harness_start_time = $at WHERE id = $id`)
      .run({ id, at });
  }

  touchRun(id: string, now: string): void {
    this.#db
      .prepare(`UPDATE runs SET alive_at = $now WHERE id = $id AND status = 'running'`)
      .run({ id, now });
  }

  recordGeneration(generation: NewGeneration): void {
    const unnamed = generation.generationId === null;
    this.#transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO generations (
            run_id, generation_id, subagent,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
            estimated_cost_usd, last_error, given_up_at, created_at
          ) VALUES (
            $run_id, $generation_id, $subagent,
            $input_tokens, $output_tokens, $cache_read_tokens, $cache_write_tokens,
            $estimated_cost_usd, $last_error, $given_up_at, $created_at
          )
          ON CONFLICT (run_id, generation_id) DO NOTHING`,
        )
        .run({
          run_id: generation.runId,
          generation_id: generation.generationId,
          subagent: generation.subagent,
          input_tokens: generation.usage.inputTokens,
          output_tokens: generation.usage.outputTokens,
          cache_read_tokens: generation.usage.cacheReadTokens,
          cache_write_tokens: generation.usage.cacheWriteTokens,
          estimated_cost_usd: generation.estimatedCostUsd,
          last_error: unnamed ? NO_GENERATION_ID : null,
          given_up_at: unnamed ? generation.createdAt : null,
          created_at: generation.createdAt,
        });
      this.#settleRun(generation.runId);
    });
  }

  recordSkillLoad(load: RunSkillLoad): void {
    this.#db
      .prepare(
        `INSERT INTO skill_loads (run_id, subagent, skill, source, loaded_at)
        VALUES ($run_id, $subagent, $skill, $source, $loaded_at)
        ON CONFLICT (run_id, subagent, skill) DO NOTHING`,
      )
      .run({
        run_id: load.runId,
        subagent: load.subagent ?? '',
        skill: load.skill,
        source: load.source,
        loaded_at: load.loadedAt,
      });
  }

  listSkillLoads(runId: string): RunSkillLoad[] {
    const rows = this.#db
      .prepare(
        'SELECT * FROM skill_loads WHERE run_id = $run_id ORDER BY loaded_at, rowid',
      )
      .all({ run_id: runId }) as SkillLoadRow[];
    return rows.map((row) => ({
      runId: row.run_id,
      subagent: row.subagent === '' ? null : row.subagent,
      skill: row.skill,
      source: row.source,
      loadedAt: row.loaded_at,
    }));
  }

  workloadSpend(runId: string): WorkloadSpend {
    const row = this.#db
      .prepare(
        `SELECT
          COALESCE(SUM(COALESCE(billed_cost_usd, estimated_cost_usd)), 0) AS cost_usd,
          COALESCE(MAX(billed_cost_usd IS NULL AND estimated_cost_usd IS NULL), 0) AS unpriced
        FROM generations WHERE run_id = $run_id`,
      )
      .get({ run_id: runId }) as { cost_usd: number; unpriced: number };
    return { costUsd: row.cost_usd, unpriced: row.unpriced === 1 };
  }

  listGenerations(runId: string): GenerationRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM generations WHERE run_id = $run_id ORDER BY id')
      .all({ run_id: runId }) as GenerationRow[];
    return rows.map(generationFromRow);
  }

  unsettledGenerations(): UnsettledGeneration[] {
    const rows = this.#db
      .prepare(
        `SELECT g.id, g.run_id, g.generation_id, COALESCE(r.end_time, g.created_at) AS since
        FROM generations g LEFT JOIN runs r ON r.id = g.run_id
        WHERE g.billed_cost_usd IS NULL AND g.given_up_at IS NULL
        ORDER BY g.id`,
      )
      .all() as UnsettledRow[];
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      generationId: row.generation_id,
      since: row.since,
    }));
  }

  recordLookups(results: LookupResult[], attemptedAt: string): void {
    this.#transaction(() => {
      const record = this.#db.prepare(
        `UPDATE generations SET
          attempts = attempts + 1,
          last_attempt_at = $attempted_at,
          billed_cost_usd = $billed_cost_usd,
          estimated_cost_usd = CASE
            WHEN $billed_cost_usd IS NULL THEN estimated_cost_usd
          END,
          reasoning_tokens = $reasoning_tokens,
          provider = $provider,
          served_model = $served_model,
          last_error = $last_error,
          given_up_at = $given_up_at
        WHERE id = $id AND billed_cost_usd IS NULL AND given_up_at IS NULL
        RETURNING run_id`,
      );
      const replaceUsage = this.#db.prepare(
        `UPDATE generations SET
          input_tokens = MAX(0, $prompt_tokens - $cache_read_tokens - cache_write_tokens),
          output_tokens = $output_tokens,
          cache_read_tokens = $cache_read_tokens
        WHERE id = $id AND cache_write_tokens IS NOT NULL`,
      );
      const runs = new Set<string>();
      for (const result of results) {
        const billing = 'billing' in result ? result.billing : null;
        const row = record.get({
          id: result.id,
          attempted_at: attemptedAt,
          billed_cost_usd: billing?.costUsd ?? null,
          reasoning_tokens: billing?.reasoningTokens ?? null,
          provider: billing?.provider ?? null,
          served_model: billing?.model ?? null,
          last_error: 'error' in result ? result.error : null,
          given_up_at: 'givenUp' in result && result.givenUp ? attemptedAt : null,
        }) as { run_id: string } | undefined;
        if (row === undefined) {
          continue;
        }
        runs.add(row.run_id);
        if (billing !== null && billing.usage !== null) {
          replaceUsage.run({
            id: result.id,
            prompt_tokens: billing.usage.promptTokens,
            cache_read_tokens: billing.usage.cacheReadTokens,
            output_tokens: billing.usage.outputTokens,
          });
        }
      }
      for (const run of runs) {
        this.#settleRun(run);
      }
    });
  }

  giveUpUnfinishedRuns(quietSince: string, givenUpAt: string): string[] {
    let runs: string[] = [];
    this.#transaction(() => {
      runs = (
        this.#db
          .prepare(
            `SELECT id FROM runs
            WHERE end_time IS NULL AND cost_status = 'pending'
              AND COALESCE(
                (SELECT MAX(created_at) FROM generations WHERE run_id = runs.id),
                start_time
              ) < $quiet_since
            ORDER BY id`,
          )
          .all({ quiet_since: quietSince }) as { id: string }[]
      ).map((row) => row.id);
      for (const run of runs) {
        this.#giveUpRun(run, givenUpAt);
      }
    });
    return runs;
  }

  interruptStaleRuns(staleSince: string, interruptedAt: string): InterruptedRun[] {
    let runs: InterruptedRun[] = [];
    this.#transaction(() => {
      runs = (
        this.#db
          .prepare(
            `SELECT id, COALESCE(alive_at, start_time) AS last_seen FROM runs
            WHERE status = 'running' AND COALESCE(alive_at, start_time) < $stale_since
            ORDER BY id`,
          )
          .all({ stale_since: staleSince }) as { id: string; last_seen: string }[]
      ).map((row) => ({ id: row.id, lastSeen: row.last_seen }));
      const interrupt = this.#db.prepare(
        `UPDATE runs SET status = 'interrupted', end_time = $last_seen, error = $error
        WHERE id = $id`,
      );
      for (const { id, lastSeen } of runs) {
        interrupt.run({ id, last_seen: lastSeen, error: stoppedWithoutFinishing(lastSeen) });
        this.#giveUpRun(id, interruptedAt);
      }
    });
    return runs;
  }

  #giveUpRun(id: string, givenUpAt: string): void {
    this.#db
      .prepare(
        `INSERT INTO generations (run_id, last_error, given_up_at, created_at)
        VALUES ($run_id, $last_error, $given_up_at, $given_up_at)`,
      )
      .run({ run_id: id, last_error: RUN_NEVER_ENDED, given_up_at: givenUpAt });
    this.#settleRun(id);
  }

  #settleRun(id: string): void {
    this.#db.prepare(SETTLE_RUN).run({ id });
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.#db
      .prepare('SELECT * FROM runs WHERE id = $id')
      .get({ id }) as RunRow | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  listRuns(): RunRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM runs ORDER BY start_time DESC')
      .all() as RunRow[];
    return rows.map(fromRow);
  }

  replaceFrontier({ repository, github, polledAt, tickets }: PolledFrontier): void {
    this.#transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO frontier_repositories (repository, github, polled_at, last_error, failed_at)
          VALUES ($repository, $github, $polled_at, NULL, NULL)
          ON CONFLICT (repository) DO UPDATE SET
            github = excluded.github,
            polled_at = excluded.polled_at,
            last_error = NULL,
            failed_at = NULL`,
        )
        .run({ repository, github, polled_at: polledAt });
      this.#db
        .prepare('DELETE FROM frontier_tickets WHERE repository = $repository')
        .run({ repository });
      const insert = this.#db.prepare(
        `INSERT INTO frontier_tickets (
          repository, number, title, url, parent_number, parent_title, parent_url, created_at,
          forge_ready, blocked
        ) VALUES (
          $repository, $number, $title, $url, $parent_number, $parent_title, $parent_url, $created_at,
          $forge_ready, $blocked
        )`,
      );
      for (const ticket of tickets) {
        insert.run({
          repository,
          number: ticket.number,
          title: ticket.title,
          url: ticket.url,
          parent_number: ticket.parent?.number ?? null,
          parent_title: ticket.parent?.title ?? null,
          parent_url: ticket.parent?.url ?? null,
          created_at: ticket.createdAt,
          forge_ready: ticket.forgeReady ? 1 : 0,
          blocked: ticket.blocked ? 1 : 0,
        });
      }
    });
  }

  recordFrontierError({
    repository,
    github,
    message,
    failedAt,
  }: { repository: string; github: string } & PollFailure): void {
    this.#db
      .prepare(
        `INSERT INTO frontier_repositories (repository, github, polled_at, last_error, failed_at)
        VALUES ($repository, $github, NULL, $message, $failed_at)
        ON CONFLICT (repository) DO UPDATE SET
          github = excluded.github,
          last_error = excluded.last_error,
          failed_at = excluded.failed_at`,
      )
      .run({ repository, github, message, failed_at: failedAt });
  }

  pruneFrontier(declared: string[]): void {
    this.#db
      .prepare(
        `DELETE FROM frontier_repositories
        WHERE repository NOT IN (SELECT value FROM json_each($declared))`,
      )
      .run({ declared: JSON.stringify(declared) });
  }

  listFrontier(): RepositoryFrontier[] {
    const repositories = this.#db
      .prepare('SELECT * FROM frontier_repositories ORDER BY repository')
      .all() as RepositoryRow[];
    const tickets = this.#db.prepare(
      'SELECT * FROM frontier_tickets WHERE repository = $repository',
    );
    return repositories.map((row) => ({
      repository: row.repository,
      github: row.github,
      polledAt: row.polled_at,
      lastError:
        row.last_error === null || row.failed_at === null
          ? null
          : { message: row.last_error, failedAt: row.failed_at },
      tickets: (tickets.all({ repository: row.repository }) as TicketRow[])
        .map(ticketFromRow)
        .toSorted(oldestFirst),
    }));
  }

  #latestDispatch(ticket: DispatchTicket): DispatchRow | undefined {
    return this.#db
      .prepare(
        `SELECT * FROM dispatches
        WHERE repository = $repository AND number = $number
        ORDER BY id DESC LIMIT 1`,
      )
      .get({ repository: ticket.repository, number: ticket.number }) as
      | DispatchRow
      | undefined;
  }

  #interruptStale(row: DispatchRow, now: string): void {
    this.#db
      .prepare(
        `UPDATE dispatches SET
          state = 'failed', reason = 'interrupted', ended_at = $ended_at
        WHERE id = $id`,
      )
      .run({ id: row.id, ended_at: now });
  }

  #insertDispatch(
    ticket: DispatchTicket,
    runId: string | null,
    state: DispatchState,
    reason: DispatchFailure | null,
    now: string,
  ): number {
    const row = this.#db
      .prepare(
        `INSERT INTO dispatches (
          repository, number, url, run_id, state, reason, started_at, alive_at, ended_at
        ) VALUES (
          $repository, $number, $url, $run_id, $state, $reason, $now, $now, $ended_at
        )
        RETURNING id`,
      )
      .get({
        repository: ticket.repository,
        number: ticket.number,
        url: ticket.url,
        run_id: runId,
        state,
        reason,
        now,
        ended_at: state === 'running' ? null : now,
      }) as { id: number };
    return row.id;
  }

  #liveDispatches(now: string): number {
    const { live } = this.#db
      .prepare(
        `SELECT COUNT(*) AS live FROM dispatches
        WHERE state = 'running' AND alive_at >= $live_since`,
      )
      .get({ live_since: liveSince(now) }) as { live: number };
    return live;
  }

  startDispatch(
    ticket: DispatchTicket,
    runId: string,
    startedAt: string,
    maxConcurrent: number,
  ): DispatchStart {
    let start: DispatchStart = { refused: 'dispatching' };
    this.#transaction(() => {
      const latest = this.#latestDispatch(ticket);
      if (latest?.state === 'running' && latest.alive_at >= liveSince(startedAt)) return;
      const live = this.#liveDispatches(startedAt);
      if (live >= maxConcurrent) {
        start = { refused: 'full', live };
        return;
      }
      if (latest?.state === 'running') this.#interruptStale(latest, startedAt);
      start = { started: this.#insertDispatch(ticket, runId, 'running', null, startedAt) };
    });
    return start;
  }

  reconcileDispatch(
    ticket: DispatchTicket,
    now: string,
  ): Exclude<DispatchState, 'running'> | null {
    let settled: Exclude<DispatchState, 'running'> | null = null;
    this.#transaction(() => {
      const latest = this.#latestDispatch(ticket);
      if (latest === undefined) {
        this.#insertDispatch(ticket, null, 'failed', 'interrupted', now);
        settled = 'failed';
      } else if (latest.state !== 'running') {
        settled = latest.state as Exclude<DispatchState, 'running'>;
      } else if (latest.alive_at < liveSince(now)) {
        this.#interruptStale(latest, now);
        settled = 'failed';
      }
    });
    return settled;
  }

  touchDispatch(id: number, now: string): void {
    this.#db
      .prepare(
        `UPDATE dispatches SET alive_at = $now WHERE id = $id AND state = 'running'`,
      )
      .run({ id, now });
  }

  endDispatch(id: number, outcome: DispatchOutcome, endedAt: string): void {
    this.#db
      .prepare(
        `UPDATE dispatches SET
          state = $state, reason = $reason, detail = $detail, ended_at = $ended_at,
          pr_number = $pr_number, pr_url = $pr_url, pr_state = $pr_state
        WHERE id = $id`,
      )
      .run({
        id,
        pr_number: outcome.state === 'done' ? outcome.pullRequest.number : null,
        pr_url: outcome.state === 'done' ? outcome.pullRequest.url : null,
        pr_state: outcome.state === 'done' ? 'open' : null,
        state: outcome.state,
        reason: outcome.state === 'failed' ? outcome.reason : null,
        detail: outcome.state === 'failed' ? boundedDetail(outcome.detail) : null,
        ended_at: endedAt,
      });
  }

  pullRequestOfRun(runId: string): PullRequestRecord | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM dispatches
        WHERE run_id = $run_id AND pr_number IS NOT NULL
        ORDER BY id DESC LIMIT 1`,
      )
      .get({ run_id: runId }) as DispatchRow | undefined;
    return row === undefined ? null : dispatchFromRow(row).pullRequest;
  }

  unsettledPullRequests(repository: string): { id: number; number: number }[] {
    return this.#db
      .prepare(
        `SELECT id, pr_number AS number FROM dispatches
        WHERE repository = $repository AND pr_state = 'open'
        ORDER BY id`,
      )
      .all({ repository }) as { id: number; number: number }[];
  }

  recordPullRequest(
    id: number,
    pullRequest: { state: PullRequestState; settledAt: string | null; rework: number },
  ): void {
    this.#db
      .prepare(
        `UPDATE dispatches SET
          pr_state = $state, pr_settled_at = $settled_at, pr_rework = $rework
        WHERE id = $id AND pr_state = 'open'`,
      )
      .run({
        id,
        state: pullRequest.state,
        settled_at: pullRequest.settledAt,
        rework: pullRequest.rework,
      });
  }

  listDispatches(now: string): DispatchRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT
          d.id, d.repository, d.number, d.url,
          CASE WHEN EXISTS (SELECT 1 FROM runs WHERE id = d.run_id) THEN d.run_id END AS run_id,
          CASE WHEN d.state = 'running' AND d.alive_at < $live_since THEN 'failed' ELSE d.state END AS state,
          CASE WHEN d.state = 'running' AND d.alive_at < $live_since THEN 'interrupted' ELSE d.reason END AS reason,
          d.detail, d.started_at, d.alive_at, d.ended_at,
          d.pr_number, d.pr_url, d.pr_state, d.pr_settled_at, d.pr_rework
        FROM dispatches d
        WHERE d.id = (
          SELECT MAX(id) FROM dispatches
          WHERE repository = d.repository AND number = d.number
        )
        ORDER BY d.repository, d.number`,
      )
      .all({ live_since: liveSince(now) }) as DispatchRow[];
    return rows.map(dispatchFromRow);
  }

  dataVersion(): number {
    const { data_version } = this.#db.prepare('PRAGMA data_version').get() as {
      data_version: number;
    };
    return data_version;
  }

  close(): void {
    this.#db.close();
  }
}
