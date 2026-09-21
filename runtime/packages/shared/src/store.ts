import { DatabaseSync } from 'node:sqlite';
import type { RunRecord, RunResult, RunStatus } from './run.ts';

type RunRow = {
  id: string;
  worker: string;
  harness: string;
  model: string;
  start_time: string;
  end_time: string | null;
  status: string;
  cost_uncertain: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  transcript_ref: string | null;
  session_id: string | null;
  error: string | null;
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS runs (
    id             TEXT PRIMARY KEY,
    worker         TEXT NOT NULL,
    harness        TEXT NOT NULL,
    model          TEXT NOT NULL,
    start_time     TEXT NOT NULL,
    end_time       TEXT,
    status         TEXT NOT NULL,
    cost_uncertain INTEGER NOT NULL,
    cost_usd       REAL NOT NULL,
    input_tokens   INTEGER NOT NULL,
    output_tokens  INTEGER NOT NULL,
    transcript_ref TEXT,
    session_id     TEXT,
    error          TEXT
  ) STRICT;
`;

const toRow = (run: RunRecord): RunRow => ({
  id: run.id,
  worker: run.worker,
  harness: run.harness,
  model: run.model,
  start_time: run.startTime,
  end_time: run.endTime,
  status: run.status,
  cost_uncertain: run.costUncertain ? 1 : 0,
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
  costUncertain: row.cost_uncertain !== 0,
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
    db.exec(SCHEMA);
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
          cost_uncertain, cost_usd, input_tokens, output_tokens,
          transcript_ref, session_id, error
        ) VALUES (
          $id, $worker, $harness, $model, $start_time, $end_time, $status,
          $cost_uncertain, $cost_usd, $input_tokens, $output_tokens,
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
          cost_uncertain = $cost_uncertain,
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
        cost_uncertain: result.costUncertain ? 1 : 0,
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

  close(): void {
    this.#db.close();
  }
}
