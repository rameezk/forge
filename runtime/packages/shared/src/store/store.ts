import type { SQLInputValue } from 'node:sqlite';
import { openConnection, type Connection } from './connection.ts';
import { Grades, riskGradeFromRow, type RecordedRiskGrade, type RiskGrade, type RiskGradeRow } from './grades.ts';
import { migrate } from './migrate.ts';
import { CURRENT_HEAD_OF_WATCH, liveConflictResolutionOn, liveOpeningDispatchOf, liveRevisionOn, liveSince, boundedDetail, Workloads } from './workloads.ts';
import {
  attemptHoldsOff,
  RETRIED_GRADING_FAILURES,
  type GradingFailure,
  type LatestAttempt,
} from './grading-policy.ts';
import { Frontier } from './frontier.ts';
import { Runs } from './runs.ts';
import { Urgency } from './urgency.ts';
import type { AutoMergeVerdict, CheckRunConclusion, FailingGate, RecordedAutoMergeVerdict } from '../auto-merge-verdict.ts';
import { type PullRequestState } from '../dispatch.ts';
import type { GenerationKind, GenerationRecord, LookupResult, NewGeneration, UnsettledGeneration } from '../generation.ts';
import type { AutoMergeCounts } from '../auto-merge-status.ts';
import type { ConfigFingerprint } from '../fingerprint.ts';
import { STALE_AFTER_MS } from '../heartbeat.ts';
import { DIAGNOSED_FAILURES } from '../diagnosis.ts';
import type { DiagnosisCategory, DiagnosisRecord, DiagnosisState, DiagnosisVerdict } from '../diagnosis.ts';
import { aggregateCohorts, outcomeOf } from '../insights.ts';
import type { RiskFilter } from '../risk.ts';
import type { ActivePair, CohortActivity, CohortInsight, InsightKind, InsightOutcome, InsightPoint, InsightsFilter, InsightsOptions, ProviderShare } from '../insights.ts';

type InsightRow = {
  id: string;
  worker: string;
  repository: string | null;
  fingerprint: string | null;
  fingerprint_hash: string | null;
  start_time: string;
  end_time: string;
  cost_usd: number | null;
  list_price: number;
  kind: string | null;
  outcome: string | null;
  input_tokens: number;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  tool_calls: number | null;
  retries: number | null;
  dispatched: number;
  pr_number: number | null;
  pr_state: string | null;
  pr_rework: number | null;
  diagnosis: string | null;
};

const pullRequestOfRow = (row: InsightRow): { state: PullRequestState; rework: number | null } | null =>
  row.pr_number === null || row.pr_state === null
    ? null
    : { state: row.pr_state as PullRequestState, rework: row.pr_rework };

const INSIGHT_FROM = `
  FROM runs r
  LEFT JOIN dispatches d ON d.run_id = r.id
  LEFT JOIN revisions v ON v.run_id = r.id
  LEFT JOIN conflict_resolutions c ON c.run_id = r.id
`;

const INSIGHT_KIND = `
  CASE WHEN d.id IS NOT NULL THEN 'dispatch'
    WHEN v.id IS NOT NULL THEN 'revision'
    WHEN c.id IS NOT NULL THEN 'conflict-resolution' END
`;

const NOT_A_DIAGNOSIS = `AND NOT EXISTS (SELECT 1 FROM diagnoses WHERE run_id = r.id)`;

const INSIGHT_WHERE = `
  WHERE r.end_time IS NOT NULL
    ${NOT_A_DIAGNOSIS}
    AND (
      ($include_manual = 1 AND (${INSIGHT_KIND}) IS NULL)
      OR (${INSIGHT_KIND}) = COALESCE($kind, ${INSIGHT_KIND})
    )
    AND ($worker IS NULL OR r.worker = $worker)
    AND ($repository IS NULL OR r.repository = $repository)
    AND ($started_from IS NULL OR substr(r.start_time, 1, 19) >= substr($started_from, 1, 19))
    AND ($started_before IS NULL OR substr(r.start_time, 1, 19) < substr($started_before, 1, 19))
`;

const insightParameters = (filter: InsightsFilter) => ({
  include_manual: filter.includeManual ? 1 : 0,
  kind: filter.kind === 'all' ? null : filter.kind,
  worker: filter.worker ?? null,
  repository: filter.repository ?? null,
  started_from: filter.startedFrom ?? null,
  started_before: filter.startedBefore ?? null,
});


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

const SELECT_DIAGNOSES = `
  SELECT
    id, run_id, failed_run_id,
    CASE WHEN state = 'running' AND alive_at < $live_since THEN 'failed' ELSE state END AS state,
    category, evidence, suggested_fix,
    CASE WHEN state = 'running' AND alive_at < $live_since THEN 'the diagnosis stopped without finishing' ELSE detail END AS detail,
    started_at, alive_at, ended_at
  FROM diagnoses
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


export class Store {
  readonly #db: Connection;
  readonly grades: Grades;
  readonly workloads: Workloads;
  readonly runs: Runs;
  readonly urgency: Urgency;
  readonly frontier: Frontier;

  private constructor(db: Connection) {
    this.#db = db;
    this.runs = new Runs(db);
    this.workloads = new Workloads(db, {
      getRun: (id) => this.runs.getRun(id),
      getFingerprint: (id) => this.runs.getFingerprint(id),
    });
    this.grades = new Grades(db, (pullRequest, closes, now) => this.workloads.pullRequestLive(pullRequest, closes, now));
    this.urgency = new Urgency(db);
    this.frontier = new Frontier(db, this.workloads);
  }

  armDiagnosis(at: string): void {
    this.#db
      .prepare(`INSERT INTO diagnosis_start (started_at) SELECT $at WHERE NOT EXISTS (SELECT 1 FROM diagnosis_start)`)
      .run({ at });
  }

  static open(path: string): Store {
    const connection = openConnection(path);
    migrate(connection);
    return new Store(connection);
  }

  static openReadOnly(path: string): Store {
    return new Store(openConnection(path, { readOnly: true }));
  }

  #insightRows(filter: InsightsFilter): InsightRow[] {
    return this.#db
      .prepare(
        `SELECT
          r.id, r.worker, r.repository, r.fingerprint, r.fingerprint_hash, r.start_time, r.end_time,
          CASE WHEN r.cost_status = 'subscription'
            THEN (SELECT CASE WHEN COUNT(*) = COUNT(list_price_equivalent_usd) THEN SUM(list_price_equivalent_usd) END FROM generations WHERE run_id = r.id)
            ELSE r.cost_usd + r.unconfirmed_estimate_usd END AS cost_usd,
          r.cost_status = 'subscription' AS list_price,
          r.input_tokens, r.cache_read_tokens, r.cache_write_tokens, r.tool_calls, r.retries,
          ${INSIGHT_KIND} AS kind, COALESCE(d.state, v.state, c.state) AS outcome,
          d.pr_number, d.pr_state, d.pr_rework,
          (SELECT CASE WHEN state = 'done' THEN category END FROM diagnoses WHERE failed_run_id = r.id ORDER BY id DESC LIMIT 1) AS diagnosis
        ${INSIGHT_FROM}${INSIGHT_WHERE}`,
      )
      .all(insightParameters(filter)) as InsightRow[];
  }

  #cohortActivity(): CohortActivity[] {
    const finished = `
      ${INSIGHT_FROM}
      WHERE r.end_time IS NOT NULL AND (${INSIGHT_KIND}) IS NOT NULL`;
    const spans = this.#db
      .prepare(
        `SELECT r.fingerprint_hash AS hash, MIN(r.start_time) AS first_run, MAX(r.start_time) AS last_run
        ${finished}
        GROUP BY r.fingerprint_hash`,
      )
      .all() as { hash: string | null; first_run: string; last_run: string }[];
    const latest = this.#db
      .prepare(
        `SELECT hash, worker, repository FROM (
          SELECT r.fingerprint_hash AS hash, r.worker AS worker, r.repository AS repository,
            ROW_NUMBER() OVER (PARTITION BY r.worker, r.repository ORDER BY r.start_time DESC, r.id DESC) AS position
          ${finished}
        )
        WHERE position = 1 AND hash IS NOT NULL AND repository IS NOT NULL
        ORDER BY worker, repository`,
      )
      .all() as { hash: string; worker: string; repository: string }[];
    const activeFor = new Map<string, ActivePair[]>();
    for (const { hash, worker, repository } of latest) {
      activeFor.set(hash, [...(activeFor.get(hash) ?? []), { worker, repository }]);
    }
    return spans.map(({ hash, first_run, last_run }) => ({
      hash,
      firstRun: first_run,
      lastRun: last_run,
      activeFor: (hash === null ? undefined : activeFor.get(hash)) ?? [],
    }));
  }

  listCohorts(filter: InsightsFilter): CohortInsight[] {
    return aggregateCohorts(
      this.#insightRows(filter).map((row) => ({
        worker: row.worker,
        repository: row.repository,
        fingerprintHash: row.fingerprint_hash,
        fingerprint: row.fingerprint === null ? null : (JSON.parse(row.fingerprint) as ConfigFingerprint),
        kind: row.kind as InsightKind | null,
        outcome: row.outcome as InsightOutcome | null,
        listPrice: row.list_price === 1,
        costUsd: row.cost_usd,
        durationMs: Date.parse(row.end_time) - Date.parse(row.start_time),
        inputTokens: row.input_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        toolCalls: row.tool_calls,
        retries: row.retries,
        pullRequest: pullRequestOfRow(row),
        diagnosis: row.diagnosis as DiagnosisCategory | null,
      })),
      this.#cohortActivity(),
    );
  }

  listPoints(filter: InsightsFilter): InsightPoint[] {
    return this.#insightRows(filter)
      .flatMap((row) =>
        row.cost_usd === null
          ? []
          : [
              {
                runId: row.id,
                fingerprintHash: row.fingerprint_hash,
                startTime: row.start_time,
                costUsd: row.cost_usd,
                listPrice: row.list_price === 1,
                outcome: outcomeOf(row.kind === 'dispatch', pullRequestOfRow(row)),
              },
            ],
      )
      .sort((a, b) => a.startTime.localeCompare(b.startTime) || a.runId.localeCompare(b.runId));
  }

  listProviderShares(filter: InsightsFilter): ProviderShare[] {
    const rows = this.#db
      .prepare(
        `SELECT r.fingerprint_hash AS hash, g.provider AS provider,
          SUM(COALESCE(g.input_tokens, 0) + COALESCE(g.output_tokens, 0)
            + COALESCE(g.cache_read_tokens, 0) + COALESCE(g.cache_write_tokens, 0)) AS tokens
        ${INSIGHT_FROM}
        JOIN generations g ON g.run_id = r.id
        ${INSIGHT_WHERE}
          AND g.provider IS NOT NULL
        GROUP BY r.fingerprint_hash, g.provider
        ORDER BY tokens DESC, g.provider`,
      )
      .all(insightParameters(filter)) as { hash: string | null; provider: string; tokens: number }[];
    const shares = new Map<string | null, ProviderShare>();
    for (const { hash, provider, tokens } of rows) {
      const share = shares.get(hash) ?? { hash, providers: [] };
      share.providers.push({ provider, tokens });
      shares.set(hash, share);
    }
    return [...shares.values()];
  }

  insightsOptions(): InsightsOptions {
    const column = (name: string): string[] =>
      (
        this.#db
          .prepare(`SELECT DISTINCT ${name} AS value FROM runs r WHERE ${name} IS NOT NULL ${NOT_A_DIAGNOSIS} ORDER BY ${name}`)
          .all() as { value: string }[]
      ).map(({ value }) => value);
    return { workers: column('worker'), repositories: column('repository') };
  }

  recordHold(repository: string, number: number, held: boolean): void {
    this.#db
      .prepare(
        held
          ? `INSERT OR IGNORE INTO pull_request_holds (repository, number) VALUES ($repository, $number)`
          : `DELETE FROM pull_request_holds WHERE repository = $repository AND number = $number`,
      )
      .run({ repository, number });
  }

  keepHolds(repository: string, numbers: readonly number[]): void {
    this.#db
      .prepare(
        `DELETE FROM pull_request_holds
        WHERE repository = $repository AND number NOT IN (SELECT value FROM json_each($numbers))`,
      )
      .run({ repository, numbers: JSON.stringify(numbers) });
  }

  heldPullRequests(): { repository: string; number: number }[] {
    const rows = this.#db
      .prepare(`SELECT repository, number FROM pull_request_holds ORDER BY repository, number`)
      .all() as { repository: string; number: number }[];
    return rows.map(({ repository, number }) => ({ repository, number }));
  }

  read<Row>(sql: string, parameters: Record<string, SQLInputValue> = {}): Row[] {
    return this.#db.prepare(sql).all(parameters) as Row[];
  }

  workloadRunning(repository: string, number: number, now: string): boolean {
    const subject = { repository, number, live_since: liveSince(now) };
    const row = this.#db
      .prepare(
        `SELECT (${liveRevisionOn('subject')}) OR (${liveConflictResolutionOn('subject')}) AS running
        FROM (SELECT $repository AS repository, $number AS number) AS subject`,
      )
      .get(subject) as { running: number };
    return row.running === 1;
  }

  markAutoMergeStarted(grade: Pick<RiskGrade, 'repository' | 'number' | 'headSha'>, at: string): void {
    this.#db
      .prepare(
        `UPDATE risk_grades SET auto_merge_started_at = $at
        WHERE repository = $repository AND number = $number AND head_sha = $head_sha AND outcome = 'open'`,
      )
      .run({ at, repository: grade.repository, number: grade.number, head_sha: grade.headSha });
  }

  clearAutoMergeStarted(grade: Pick<RiskGrade, 'repository' | 'number' | 'headSha'>): void {
    this.#db
      .prepare(
        `UPDATE risk_grades SET auto_merge_started_at = NULL
        WHERE repository = $repository AND number = $number AND head_sha = $head_sha AND outcome = 'open'`,
      )
      .run({ repository: grade.repository, number: grade.number, head_sha: grade.headSha });
  }

  openGradedPullRequests(repositories: readonly string[]): RecordedRiskGrade[] {
    const rows = this.#db
      .prepare(
        `SELECT risk_grades.* FROM risk_grades
        ${CURRENT_HEAD_OF_WATCH}
        WHERE risk_grades.outcome = 'open'
          AND risk_grades.repository IN (SELECT value FROM json_each($repositories))
        ORDER BY risk_grades.repository, risk_grades.number`,
      )
      .all({ repositories: JSON.stringify(repositories) }) as RiskGradeRow[];
    return rows.map(riskGradeFromRow);
  }

  autoMergeCounts(filter: Omit<RiskFilter, 'fingerprint'>): AutoMergeCounts {
    const bounds = {
      repository: filter.repository ?? null,
      from: filter.gradedFrom ?? null,
      before: filter.gradedBefore ?? null,
    };
    const count = (table: string, condition: string, at: string): number =>
      (
        this.#db
          .prepare(
            `SELECT COUNT(*) AS n FROM ${table}
            WHERE ${condition}
              AND ($repository IS NULL OR repository = $repository)
              AND ($from IS NULL OR ${at} >= $from)
              AND ($before IS NULL OR ${at} < $before)`,
          )
          .get(bounds) as { n: number }
      ).n;
    return {
      autoMerged: count('risk_grades', "outcome = 'auto-merged'", 'graded_at'),
      sampled: count('auto_merge_samples', 'sampled = 1', 'drawn_at'),
    };
  }

  recordSample(repository: string, number: number, sampled: boolean, at: string): void {
    this.#db
      .prepare(
        `INSERT INTO auto_merge_samples (repository, number, sampled, drawn_at)
        VALUES ($repository, $number, $sampled, $at)
        ON CONFLICT (repository, number) DO UPDATE SET sampled = excluded.sampled, drawn_at = excluded.drawn_at`,
      )
      .run({ repository, number, sampled: sampled ? 1 : 0, at });
  }

  markSampleAnnounced(repository: string, number: number): void {
    this.#db
      .prepare(`UPDATE auto_merge_samples SET announced = 1 WHERE repository = $repository AND number = $number`)
      .run({ repository, number });
  }

  autoMergeVerdict(repository: string, number: number, headSha: string): RecordedAutoMergeVerdict | null {
    const row = this.#db
      .prepare(
        `SELECT verdict, conclusion, check_run_id FROM auto_merge_verdicts
        WHERE repository = $repository AND number = $number AND head_sha = $head_sha`,
      )
      .get({ repository, number, head_sha: headSha }) as
      | { verdict: string; conclusion: string; check_run_id: number }
      | undefined;
    return row === undefined
      ? null
      : {
          verdict: JSON.parse(row.verdict) as AutoMergeVerdict,
          conclusion: row.conclusion as CheckRunConclusion,
          checkRunId: row.check_run_id,
        };
  }

  currentFailingGates(): { repository: string; number: number; gates: FailingGate[] }[] {
    const rows = this.#db
      .prepare(
        `SELECT auto_merge_verdicts.repository, auto_merge_verdicts.number, auto_merge_verdicts.verdict
        FROM auto_merge_verdicts
        ${CURRENT_HEAD_OF_WATCH}
        JOIN risk_grades USING (repository, number, head_sha)
        ORDER BY auto_merge_verdicts.repository, auto_merge_verdicts.number`,
      )
      .all() as { repository: string; number: number; verdict: string }[];
    return rows.flatMap(({ repository, number, verdict }) => {
      const parsed = JSON.parse(verdict) as AutoMergeVerdict;
      return parsed.kind === 'waits' && parsed.gates.length > 0 ? [{ repository, number, gates: parsed.gates }] : [];
    });
  }

  recordAutoMergeVerdict(
    repository: string,
    number: number,
    headSha: string,
    { verdict, conclusion, checkRunId }: RecordedAutoMergeVerdict,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO auto_merge_verdicts (repository, number, head_sha, verdict, conclusion, check_run_id)
        VALUES ($repository, $number, $head_sha, $verdict, $conclusion, $check_run_id)
        ON CONFLICT (repository, number, head_sha) DO UPDATE SET
          verdict = excluded.verdict,
          conclusion = excluded.conclusion,
          check_run_id = excluded.check_run_id`,
      )
      .run({
        repository,
        number,
        head_sha: headSha,
        verdict: JSON.stringify(verdict),
        conclusion,
        check_run_id: checkRunId,
      });
  }

  sampledPullRequests(): { repository: string; number: number }[] {
    return this.#db
      .prepare(`SELECT repository, number FROM auto_merge_samples WHERE sampled = 1 ORDER BY repository, number`)
      .all() as { repository: string; number: number }[];
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
