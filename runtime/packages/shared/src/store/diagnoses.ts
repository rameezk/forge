import type { Connection } from './connection.ts';
import { boundedDetail, liveSince } from './fragments.ts';
import { DIAGNOSED_FAILURES } from '../diagnosis.ts';
import type { DiagnosisCategory, DiagnosisRecord, DiagnosisState, DiagnosisVerdict } from '../diagnosis.ts';

type DiagnosisRow = {
  id: number;
  run_id: string;
  failed_run_id: string;
  state: string;
  category: string | null;
  evidence: string | null;
  suggested_fix: string | null;
  detail: string | null;
  started_at: string;
  alive_at: string;
  ended_at: string | null;
};

const diagnosisFromRow = (row: DiagnosisRow): DiagnosisRecord => ({
  id: row.id,
  runId: row.run_id,
  failedRunId: row.failed_run_id,
  state: row.state as DiagnosisState,
  verdict:
    row.category === null || row.evidence === null || row.suggested_fix === null
      ? null
      : {
          category: row.category as DiagnosisVerdict['category'],
          evidence: JSON.parse(row.evidence) as DiagnosisVerdict['evidence'],
          suggestedFix: row.suggested_fix,
        },
  detail: row.detail,
  startedAt: row.started_at,
  endedAt: row.ended_at,
});

const DIAGNOSIS_STOPPED_WITHOUT_FINISHING = 'the diagnosis stopped without finishing';

const SELECT_DIAGNOSES = `
  SELECT
    id, run_id, failed_run_id,
    CASE WHEN state = 'running' AND alive_at < $live_since THEN 'failed' ELSE state END AS state,
    category, evidence, suggested_fix,
    CASE WHEN state = 'running' AND alive_at < $live_since THEN '${DIAGNOSIS_STOPPED_WITHOUT_FINISHING}' ELSE detail END AS detail,
    started_at, alive_at, ended_at
  FROM diagnoses
`;

export const NOT_A_DIAGNOSIS = `AND NOT EXISTS (SELECT 1 FROM diagnoses WHERE run_id = r.id)`;

export const LATEST_DIAGNOSIS_CATEGORY = `
  (SELECT CASE WHEN state = 'done' THEN category END FROM diagnoses WHERE failed_run_id = r.id ORDER BY id DESC LIMIT 1)
`;

export interface UndiagnosedFailure {
  runId: string;
  kind: 'dispatch' | 'revision' | 'conflict-resolution';
  repository: string;
  number: number;
}

const DIAGNOSABLE_FAILURES = `
  SELECT run_id, 'dispatch' AS kind, repository, number, reason, ended_at FROM dispatches
  UNION ALL
  SELECT run_id, 'revision', repository, number, reason, ended_at FROM revisions
  UNION ALL
  SELECT run_id, 'conflict-resolution', repository, number, reason, ended_at FROM conflict_resolutions
`;

export class Diagnoses {
  readonly #db: Connection;

  constructor(db: Connection) {
    this.#db = db;
  }

  armDiagnosis(at: string): void {
    this.#db
      .prepare(`INSERT INTO diagnosis_start (started_at) SELECT $at WHERE NOT EXISTS (SELECT 1 FROM diagnosis_start)`)
      .run({ at });
  }

  undiagnosedFailures(): UndiagnosedFailure[] {
    const reasons = DIAGNOSED_FAILURES.map((reason) => `'${reason}'`).join(', ');
    const rows = this.#db
      .prepare(
        `SELECT f.run_id, f.kind, f.repository, f.number FROM (${DIAGNOSABLE_FAILURES}) f
        WHERE f.run_id IS NOT NULL AND f.reason IN (${reasons})
          AND f.ended_at >= (SELECT MIN(started_at) FROM diagnosis_start)
          AND NOT EXISTS (SELECT 1 FROM diagnoses d WHERE d.failed_run_id = f.run_id)
        ORDER BY f.ended_at, f.run_id`,
      )
      .all() as { run_id: string; kind: UndiagnosedFailure['kind']; repository: string; number: number }[];
    return rows.map(({ run_id, kind, repository, number }) => ({ runId: run_id, kind, repository, number }));
  }

  startDiagnosis(failedRunId: string, runId: string, at: string): number {
    const row = this.#db
      .prepare(
        `INSERT INTO diagnoses (run_id, failed_run_id, state, started_at, alive_at)
        VALUES ($run_id, $failed_run_id, 'running', $at, $at)
        RETURNING id`,
      )
      .get({ run_id: runId, failed_run_id: failedRunId, at }) as { id: number };
    return row.id;
  }

  startDiagnosisUnlessRunning(failedRunId: string, runId: string, at: string): number | null {
    const row = this.#db
      .prepare(
        `INSERT INTO diagnoses (run_id, failed_run_id, state, started_at, alive_at)
        SELECT $run_id, $failed_run_id, 'running', $at, $at
        WHERE NOT EXISTS (
          SELECT 1 FROM diagnoses
          WHERE failed_run_id = $failed_run_id AND state = 'running' AND alive_at >= $live_since
        )
        RETURNING id`,
      )
      .get({ run_id: runId, failed_run_id: failedRunId, at, live_since: liveSince(at) }) as { id: number } | undefined;
    return row?.id ?? null;
  }

  discardDiagnosis(id: number): void {
    this.#db.prepare(`DELETE FROM diagnoses WHERE id = $id AND state = 'running'`).run({ id });
  }

  touchDiagnosis(id: number, now: string): void {
    this.#db.prepare(`UPDATE diagnoses SET alive_at = $now WHERE id = $id AND state = 'running'`).run({ id, now });
  }

  endDiagnosis(
    id: number,
    state: Exclude<DiagnosisState, 'running'>,
    endedAt: string,
    result: { verdict?: DiagnosisVerdict; detail?: string | null },
  ): void {
    this.#db
      .prepare(
        `UPDATE diagnoses SET
          state = $state, category = $category, evidence = $evidence, suggested_fix = $suggested_fix,
          detail = $detail, ended_at = $ended_at
        WHERE id = $id`,
      )
      .run({
        id,
        state,
        category: result.verdict?.category ?? null,
        evidence: result.verdict === undefined ? null : JSON.stringify(result.verdict.evidence),
        suggested_fix: result.verdict?.suggestedFix ?? null,
        detail: boundedDetail(result.detail ?? null),
        ended_at: endedAt,
      });
  }

  diagnosesOf(failedRunId: string, now: string): DiagnosisRecord[] {
    return (
      this.#db
        .prepare(`${SELECT_DIAGNOSES} WHERE failed_run_id = $failed_run_id ORDER BY id DESC`)
        .all({ failed_run_id: failedRunId, live_since: liveSince(now) }) as DiagnosisRow[]
    ).map(diagnosisFromRow);
  }

  diagnosisOfRun(runId: string, now: string): DiagnosisRecord | null {
    const row = this.#db
      .prepare(`${SELECT_DIAGNOSES} WHERE run_id = $run_id`)
      .get({ run_id: runId, live_since: liveSince(now) }) as DiagnosisRow | undefined;
    return row === undefined ? null : diagnosisFromRow(row);
  }

  latestDiagnosisCategories(now: string): Map<string, DiagnosisCategory> {
    const categories = new Map<string, DiagnosisCategory>();
    for (const { failedRunId, verdict } of this.listDiagnoses(now)) {
      if (verdict === null) categories.delete(failedRunId);
      else categories.set(failedRunId, verdict.category);
    }
    return categories;
  }

  listDiagnoses(now: string): DiagnosisRecord[] {
    return (
      this.#db.prepare(`${SELECT_DIAGNOSES} ORDER BY id`).all({ live_since: liveSince(now) }) as DiagnosisRow[]
    ).map(diagnosisFromRow);
  }
}
