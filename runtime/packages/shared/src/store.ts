import { DatabaseSync } from 'node:sqlite';
import {
  oldestFirst,
  type PolledFrontier,
  type PollFailure,
  type RepositoryFrontier,
  type Ticket,
} from './frontier.ts';
import type {
  GenerationRecord,
  LookupResult,
  NewGeneration,
  UnsettledGeneration,
} from './generation.ts';
import type { CostStatus, RunRecord, RunResult, RunStatus } from './run.ts';

type RunRow = {
  id: string;
  worker: string;
  harness: string;
  model: string;
  start_time: string;
  end_time: string | null;
  status: string;
  cost_status: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  transcript_ref: string | null;
  session_id: string | null;
  error: string | null;
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
    error          TEXT
  ) STRICT;
`;

const BUSY_TIMEOUT_MS = 5000;

type GenerationRow = {
  run_id: string;
  generation_id: string | null;
  subagent: string | null;
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
    UNIQUE (run_id, generation_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS generations_unsettled ON generations (id)
    WHERE billed_cost_usd IS NULL AND given_up_at IS NULL;
`;

const NO_GENERATION_ID = 'no generation id';

const RUN_NEVER_ENDED = 'run never ended, so later generations may be unrecorded';

const SETTLE_RUN_COST = `
  UPDATE runs SET
    cost_usd = (
      SELECT COALESCE(SUM(billed_cost_usd), 0) FROM generations WHERE run_id = runs.id
    ),
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
  created_at: string;
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
    created_at    TEXT NOT NULL,
    PRIMARY KEY (repository, number)
  ) STRICT;
`;

const HAS_OUTDATED_FRONTIER = `
  SELECT 1 FROM sqlite_master
  WHERE type = 'table' AND name = 'frontier_repositories'
    AND NOT EXISTS (
      SELECT 1 FROM pragma_table_info('frontier_repositories') WHERE name = 'failed_at'
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
  start_time: run.startTime,
  end_time: run.endTime,
  status: run.status,
  cost_status: run.costStatus,
  cost_usd: run.costUsd,
  input_tokens: run.inputTokens,
  output_tokens: run.outputTokens,
  transcript_ref: run.transcriptRef,
  session_id: run.sessionId,
  error: run.error,
});

const ticketFromRow = (row: TicketRow): Ticket => ({
  number: row.number,
  title: row.title,
  url: row.url,
  parent:
    row.parent_number === null || row.parent_title === null
      ? null
      : { number: row.parent_number, title: row.parent_title },
  createdAt: row.created_at,
});

const generationFromRow = (row: GenerationRow): GenerationRecord => ({
  runId: row.run_id,
  generationId: row.generation_id,
  subagent: row.subagent,
  billedCostUsd: row.billed_cost_usd,
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
  startTime: row.start_time,
  endTime: row.end_time,
  status: row.status as RunStatus,
  costStatus: row.cost_status as CostStatus,
  costUsd: row.cost_usd,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  transcriptRef: row.transcript_ref,
  sessionId: row.session_id,
  error: row.error,
});

export class Store {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
    this.#useWriteAheadLog();
    if (this.#hasCostUncertain()) {
      this.#migrateCostUncertain();
    }
    db.exec(CREATE_RUNS);
    db.exec(CREATE_GENERATIONS);
    if (this.#hasOutdatedFrontier()) {
      this.#migrateOutdatedFrontier();
    }
    db.exec(CREATE_FRONTIER);
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
          id, worker, harness, model, start_time, end_time, status,
          cost_status, cost_usd, input_tokens, output_tokens,
          transcript_ref, session_id, error
        ) VALUES (
          $id, $worker, $harness, $model, $start_time, $end_time, $status,
          $cost_status, $cost_usd, $input_tokens, $output_tokens,
          $transcript_ref, $session_id, $error
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
            input_tokens = $input_tokens,
            output_tokens = $output_tokens,
            session_id = $session_id,
            error = $error
          WHERE id = $id`,
        )
        .run({
          id,
          end_time: result.endTime,
          status: result.status,
          input_tokens: result.inputTokens,
          output_tokens: result.outputTokens,
          session_id: result.sessionId,
          error: result.error,
        });
      this.#settleRunCost(id);
    });
  }

  recordGeneration(generation: NewGeneration): void {
    const unnamed = generation.generationId === null;
    this.#transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO generations (
            run_id, generation_id, subagent, last_error, given_up_at, created_at
          ) VALUES (
            $run_id, $generation_id, $subagent, $last_error, $given_up_at, $created_at
          )
          ON CONFLICT (run_id, generation_id) DO NOTHING`,
        )
        .run({
          run_id: generation.runId,
          generation_id: generation.generationId,
          subagent: generation.subagent,
          last_error: unnamed ? NO_GENERATION_ID : null,
          given_up_at: unnamed ? generation.createdAt : null,
          created_at: generation.createdAt,
        });
      this.#settleRunCost(generation.runId);
    });
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
          last_error = $last_error,
          given_up_at = $given_up_at
        WHERE id = $id AND billed_cost_usd IS NULL AND given_up_at IS NULL
        RETURNING run_id`,
      );
      const runs = new Set<string>();
      for (const result of results) {
        const billed = 'billedCostUsd' in result;
        const row = record.get({
          id: result.id,
          attempted_at: attemptedAt,
          billed_cost_usd: billed ? result.billedCostUsd : null,
          last_error: billed ? null : result.error,
          given_up_at: !billed && result.givenUp ? attemptedAt : null,
        }) as { run_id: string } | undefined;
        if (row !== undefined) {
          runs.add(row.run_id);
        }
      }
      for (const run of runs) {
        this.#settleRunCost(run);
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
      const giveUp = this.#db.prepare(
        `INSERT INTO generations (run_id, last_error, given_up_at, created_at)
        VALUES ($run_id, $last_error, $given_up_at, $given_up_at)`,
      );
      for (const run of runs) {
        giveUp.run({
          run_id: run,
          last_error: RUN_NEVER_ENDED,
          given_up_at: givenUpAt,
        });
        this.#settleRunCost(run);
      }
    });
    return runs;
  }

  #settleRunCost(id: string): void {
    this.#db.prepare(SETTLE_RUN_COST).run({ id });
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
          repository, number, title, url, parent_number, parent_title, created_at
        ) VALUES (
          $repository, $number, $title, $url, $parent_number, $parent_title, $created_at
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
          created_at: ticket.createdAt,
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

  close(): void {
    this.#db.close();
  }
}
