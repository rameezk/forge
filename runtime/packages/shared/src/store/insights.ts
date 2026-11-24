import type { Connection } from './connection.ts';
import { aggregateCohorts, outcomeOf } from '../insights.ts';
import type { ActivePair, CohortActivity, CohortInsight, InsightKind, InsightOutcome, InsightPoint, InsightsFilter, InsightsOptions, ProviderShare } from '../insights.ts';
import type { ConfigFingerprint } from '../fingerprint.ts';
import type { DiagnosisCategory } from '../diagnosis.ts';
import type { PullRequestState } from '../dispatch.ts';

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

export class Insights {
  readonly #db: Connection;

  constructor(db: Connection) {
    this.#db = db;
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

  options(): InsightsOptions {
    const column = (name: string): string[] =>
      (
        this.#db
          .prepare(`SELECT DISTINCT ${name} AS value FROM runs r WHERE ${name} IS NOT NULL ${NOT_A_DIAGNOSIS} ORDER BY ${name}`)
          .all() as { value: string }[]
      ).map(({ value }) => value);
    return { workers: column('worker'), repositories: column('repository') };
  }
}
