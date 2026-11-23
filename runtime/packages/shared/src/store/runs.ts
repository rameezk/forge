import type { Connection } from './connection.ts';
import { GIVEN_UP_ESTIMATE } from './migrations/runs.ts';
import type {
  GenerationKind,
  GenerationRecord,
  LookupResult,
  NewGeneration,
  UnsettledGeneration,
} from '../generation.ts';
import { UNKNOWN_COHORT } from '../fingerprint.ts';
import type { ConfigFingerprint, RunFingerprint } from '../fingerprint.ts';
import type { RunSkillLoad } from '../skill-loads.ts';
import type {
  CostStatus,
  ExceededLimit,
  InterruptedRun,
  RunCounters,
  RunRecord,
  RunResult,
  RunStatus,
} from '../run.ts';

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
  unconfirmed_estimate_usd: number;
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
  tool_calls: number | null;
  failed_tool_results: number | null;
  retries: number | null;
  compactions: number | null;
};

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
  kind: GenerationKind;
  estimated_cost_usd: number | null;
  list_price_equivalent_usd: number | null;
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

type SkillLoadRow = {
  run_id: string;
  subagent: string;
  skill: string;
  source: 'prompt' | 'read';
  loaded_at: string;
  lines_covered: number | null;
  total_lines: number | null;
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
    unconfirmed_estimate_usd = ${GIVEN_UP_ESTIMATE},
    cost_status = CASE
      WHEN cost_status = 'subscription' THEN 'subscription'
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
  unconfirmed_estimate_usd: run.unconfirmedEstimateUsd,
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
  tool_calls: run.counters?.toolCalls ?? null,
  failed_tool_results: run.counters?.failedToolResults ?? null,
  retries: run.counters?.retries ?? null,
  compactions: run.counters?.compactions ?? null,
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
  listPriceEquivalentUsd: row.list_price_equivalent_usd,
  billedCostUsd: row.billed_cost_usd,
  reasoningTokens: row.reasoning_tokens,
  provider: row.provider,
  servedModel: row.served_model,
  kind: row.kind,
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
  unconfirmedEstimateUsd: row.unconfirmed_estimate_usd,
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
  counters:
    row.tool_calls === null ||
    row.failed_tool_results === null ||
    row.retries === null ||
    row.compactions === null
      ? null
      : {
          toolCalls: row.tool_calls,
          failedToolResults: row.failed_tool_results,
          retries: row.retries,
          compactions: row.compactions,
        },
});

export interface ListPriceEquivalent {
  usd: number;
  partial: boolean;
}

export interface WorkloadSpend {
  costUsd: number;
  unpriced: boolean;
}

export class Runs {
  readonly #db: Connection;

  constructor(db: Connection) {
    this.#db = db;
  }

  insertRun(run: RunRecord): void {
    const row = toRow(run);
    this.#db
      .prepare(
        `INSERT INTO runs (
          id, worker, harness, model, reasoning_effort, start_time, end_time, status,
          cost_status, cost_usd, cost_estimated, unconfirmed_estimate_usd,
          input_price, output_price, cache_read_price, cache_write_price,
          input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens,
          transcript_ref, session_id, error,
          repository, ticket_number, ticket_url, alive_at,
          harness_start_time, timeout_seconds, exceeded_limit, max_cost_usd,
          tool_calls, failed_tool_results, retries, compactions,
          skill_loads_recorded
        ) VALUES (
          $id, $worker, $harness, $model, $reasoning_effort, $start_time, $end_time, $status,
          $cost_status, $cost_usd, $cost_estimated, $unconfirmed_estimate_usd,
          $input_price, $output_price, $cache_read_price, $cache_write_price,
          $input_tokens, $output_tokens,
          $cache_read_tokens, $cache_write_tokens,
          $transcript_ref, $session_id, $error,
          $repository, $ticket_number, $ticket_url, $alive_at,
          $harness_start_time, $timeout_seconds, $exceeded_limit, $max_cost_usd,
          $tool_calls, $failed_tool_results, $retries, $compactions,
          1
        )`,
      )
      .run(row);
  }

  finalizeRun(id: string, result: RunResult): void {
    this.#db.transaction(() => {
      this.#db
        .prepare(
          `UPDATE runs SET
            end_time = $end_time,
            status = $status,
            session_id = $session_id,
            error = $error,
            exceeded_limit = $exceeded_limit,
            tool_calls = COALESCE($tool_calls, tool_calls),
            failed_tool_results = COALESCE($failed_tool_results, failed_tool_results),
            retries = COALESCE($retries, retries),
            compactions = COALESCE($compactions, compactions)
          WHERE id = $id`,
        )
        .run({
          id,
          end_time: result.endTime,
          status: result.status,
          session_id: result.sessionId,
          error: result.error,
          exceeded_limit: result.exceededLimit ?? null,
          tool_calls: result.counters?.toolCalls ?? null,
          failed_tool_results: result.counters?.failedToolResults ?? null,
          retries: result.counters?.retries ?? null,
          compactions: result.counters?.compactions ?? null,
        });
      this.#settleRun(id);
    });
  }

  recordFingerprint(id: string, recorded: RunFingerprint): void {
    this.#db
      .prepare(
        `UPDATE runs SET
          fingerprint = $fingerprint,
          fingerprint_hash = $hash,
          forge_git_sha = $forge_git_sha,
          base_commit = $base_commit
        WHERE id = $id AND fingerprint IS NULL`,
      )
      .run({
        id,
        fingerprint: JSON.stringify(recorded.fingerprint),
        hash: recorded.hash,
        forge_git_sha: recorded.forgeGitSha,
        base_commit: recorded.baseCommit,
      });
  }

  getFingerprint(id: string): RunFingerprint | null {
    const row = this.#db
      .prepare(
        `SELECT fingerprint, fingerprint_hash, forge_git_sha, base_commit
        FROM runs WHERE id = $id AND fingerprint IS NOT NULL`,
      )
      .get({ id }) as
      | {
          fingerprint: string;
          fingerprint_hash: string;
          forge_git_sha: string | null;
          base_commit: string | null;
        }
      | undefined;
    return row === undefined
      ? null
      : {
          fingerprint: JSON.parse(row.fingerprint) as ConfigFingerprint,
          hash: row.fingerprint_hash,
          forgeGitSha: row.forge_git_sha,
          baseCommit: row.base_commit,
        };
  }

  getCohortFingerprint(hash: string): ConfigFingerprint | null {
    const row = this.#db
      .prepare('SELECT fingerprint FROM runs WHERE fingerprint_hash = $hash AND fingerprint IS NOT NULL LIMIT 1')
      .get({ hash }) as { fingerprint: string } | undefined;
    return row === undefined ? null : (JSON.parse(row.fingerprint) as ConfigFingerprint);
  }

  listCohortFingerprints(): { hash: string; fingerprint: ConfigFingerprint }[] {
    const rows = this.#db
      .prepare(
        `SELECT fingerprint_hash AS hash, fingerprint FROM runs
        WHERE fingerprint IS NOT NULL
        GROUP BY fingerprint_hash
        ORDER BY MAX(start_time) DESC, fingerprint_hash`,
      )
      .all() as { hash: string; fingerprint: string }[];
    return rows.map(({ hash, fingerprint }) => ({ hash, fingerprint: JSON.parse(fingerprint) as ConfigFingerprint }));
  }

  runCohorts(): Map<string, string> {
    const rows = this.#db.prepare('SELECT id, fingerprint_hash FROM runs').all() as { id: string; fingerprint_hash: string | null }[];
    return new Map(rows.map(({ id, fingerprint_hash }) => [id, fingerprint_hash ?? UNKNOWN_COHORT]));
  }

  hasUnknownConfigRuns(): boolean {
    return this.#db.prepare('SELECT 1 FROM runs WHERE fingerprint IS NULL LIMIT 1').get() !== undefined;
  }

  recordCounters(id: string, counters: RunCounters): void {
    this.#db
      .prepare(
        `UPDATE runs SET
          tool_calls = $tool_calls,
          failed_tool_results = $failed_tool_results,
          retries = $retries,
          compactions = $compactions
        WHERE id = $id AND tool_calls IS NULL`,
      )
      .run({
        id,
        tool_calls: counters.toolCalls,
        failed_tool_results: counters.failedToolResults,
        retries: counters.retries,
        compactions: counters.compactions,
      });
  }

  runsWithoutCounters(): { id: string; transcriptRef: string }[] {
    const rows = this.#db
      .prepare(
        `SELECT id, transcript_ref FROM runs
        WHERE status != 'running' AND tool_calls IS NULL AND transcript_ref IS NOT NULL
        ORDER BY id`,
      )
      .all() as { id: string; transcript_ref: string }[];
    return rows.map((row) => ({ id: row.id, transcriptRef: row.transcript_ref }));
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
    const lastError =
      generation.givenUpBecause ??
      (generation.generationId === null ? NO_GENERATION_ID : null);
    this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO generations (
            run_id, generation_id, subagent, kind,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
            estimated_cost_usd, list_price_equivalent_usd, last_error, given_up_at, created_at
          ) VALUES (
            $run_id, $generation_id, $subagent, $kind,
            $input_tokens, $output_tokens, $cache_read_tokens, $cache_write_tokens,
            $estimated_cost_usd, $list_price_equivalent_usd, $last_error, $given_up_at, $created_at
          )
          ON CONFLICT (run_id, generation_id) DO NOTHING`,
        )
        .run({
          run_id: generation.runId,
          generation_id: generation.generationId,
          subagent: generation.subagent,
          kind: generation.kind,
          input_tokens: generation.usage.inputTokens,
          output_tokens: generation.usage.outputTokens,
          cache_read_tokens: generation.usage.cacheReadTokens,
          cache_write_tokens: generation.usage.cacheWriteTokens,
          estimated_cost_usd: generation.estimatedCostUsd,
          list_price_equivalent_usd: generation.listPriceEquivalentUsd ?? null,
          last_error: lastError,
          given_up_at: lastError === null ? null : generation.createdAt,
          created_at: generation.createdAt,
        });
      this.#settleRun(generation.runId);
    });
  }

  recordSkillLoad(load: RunSkillLoad): void {
    this.#db
      .prepare(
        `INSERT INTO skill_loads (run_id, subagent, skill, source, loaded_at, lines_covered, total_lines)
        VALUES ($run_id, $subagent, $skill, $source, $loaded_at, $lines_covered, $total_lines)
        ON CONFLICT (run_id, subagent, skill) DO UPDATE SET
          lines_covered = excluded.lines_covered,
          total_lines = excluded.total_lines`,
      )
      .run({
        run_id: load.runId,
        subagent: load.subagent ?? '',
        skill: load.skill,
        source: load.source,
        loaded_at: load.loadedAt,
        lines_covered: load.coverage?.coveredLines ?? null,
        total_lines: load.coverage?.totalLines ?? null,
      });
  }

  runsWithoutSkillLoadRecord(): { id: string; transcriptRef: string | null }[] {
    const rows = this.#db
      .prepare(
        `SELECT id, transcript_ref FROM runs
        WHERE status != 'running' AND skill_loads_recorded IS NULL
        ORDER BY id`,
      )
      .all() as { id: string; transcript_ref: string | null }[];
    return rows.map((row) => ({ id: row.id, transcriptRef: row.transcript_ref }));
  }

  recordBackfilledSkillLoads(runId: string, loads: RunSkillLoad[] | null): void {
    this.#db.transaction(() => {
      const marked = this.#db
        .prepare(
          `UPDATE runs SET skill_loads_recorded = $recorded
          WHERE id = $id AND skill_loads_recorded IS NULL`,
        )
        .run({ id: runId, recorded: loads === null ? 0 : 1 });
      if (marked.changes === 0) {
        return;
      }
      for (const load of loads ?? []) {
        this.recordSkillLoad(load);
      }
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
      coverage:
        row.lines_covered === null || row.total_lines === null
          ? null
          : { coveredLines: row.lines_covered, totalLines: row.total_lines },
    }));
  }

  workloadSpend(runId: string): WorkloadSpend {
    const row = this.#db
      .prepare(
        `SELECT
          COALESCE(SUM(COALESCE(billed_cost_usd, estimated_cost_usd, list_price_equivalent_usd)), 0) AS cost_usd,
          COALESCE(MAX(billed_cost_usd IS NULL AND estimated_cost_usd IS NULL AND list_price_equivalent_usd IS NULL), 0) AS unpriced
        FROM generations WHERE run_id = $run_id`,
      )
      .get({ run_id: runId }) as { cost_usd: number; unpriced: number };
    return { costUsd: row.cost_usd, unpriced: row.unpriced === 1 };
  }

  listPriceEquivalents(): Map<string, ListPriceEquivalent> {
    const rows = this.#db
      .prepare(
        `SELECT run_id,
          SUM(list_price_equivalent_usd) AS usd,
          MAX(list_price_equivalent_usd IS NULL) AS partial
        FROM generations
        GROUP BY run_id
        HAVING COUNT(list_price_equivalent_usd) > 0`,
      )
      .all() as { run_id: string; usd: number; partial: number }[];
    return new Map(rows.map(({ run_id, usd, partial }) => [run_id, { usd, partial: partial === 1 }]));
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
          AND COALESCE(r.cost_status, '') != 'subscription'
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
    this.#db.transaction(() => {
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
    this.#db.transaction(() => {
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
    this.#db.transaction(() => {
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
}
