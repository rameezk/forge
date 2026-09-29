import { DatabaseSync } from 'node:sqlite';
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
    if (this.#hasCostUncertain()) {
      this.#migrateCostUncertain();
    }
    db.exec(CREATE_RUNS);
  }

  #hasCostUncertain(): boolean {
    return this.#db.prepare(HAS_COST_UNCERTAIN).get() !== undefined;
  }

  #migrateCostUncertain(): void {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      if (this.#hasCostUncertain()) {
        this.#db.exec(MIGRATE_COST_UNCERTAIN);
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  static open(path: string): Store {
    return new Store(new DatabaseSync(path));
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
    this.#db
      .prepare(
        `UPDATE runs SET
          end_time = $end_time,
          status = $status,
          cost_status = $cost_status,
          cost_usd = $cost_usd,
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
        cost_status: result.costStatus,
        cost_usd: result.costUsd,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        session_id: result.sessionId,
        error: result.error,
      });
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

  close(): void {
    this.#db.close();
  }
}
