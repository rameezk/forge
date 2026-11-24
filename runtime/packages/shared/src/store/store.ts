import type { SQLInputValue } from 'node:sqlite';
import { openConnection, type Connection } from './connection.ts';
import { migrate } from './migrate.ts';
import { CURRENT_HEAD_OF_WATCH, liveConflictResolutionOn, liveOpeningDispatchOf, liveRevisionOn, boundedDetail, Workloads } from './workloads.ts';
import { AutoMerge } from './auto-merge.ts';
import { liveSince } from './liveness.ts';
import {
  attemptHoldsOff,
  RETRIED_GRADING_FAILURES,
  type GradingFailure,
  type LatestAttempt,
} from './grading-policy.ts';
import { Runs } from './runs.ts';
import { riskGradeFromRow, type RiskGradeRow } from './risk-grade-row.ts';
import { Urgency } from './urgency.ts';
import { newestClosedFirst, oldestFirst, type ClosedTicket, type PolledFrontier, type PollFailure, type RepositoryProblems, type RefinementRequest, type RepositoryFrontier, type Ticket } from '../frontier.ts';
import { type PullRequestState } from '../dispatch.ts';
import type { ConfigFingerprint } from '../fingerprint.ts';
import { DIAGNOSED_FAILURES } from '../diagnosis.ts';
import type { DiagnosisCategory, DiagnosisRecord, DiagnosisState, DiagnosisVerdict } from '../diagnosis.ts';
import { aggregateCohorts, outcomeOf } from '../insights.ts';
import type { RiskFilter, RiskOptions } from '../risk.ts';
import type { ActivePair, CohortActivity, CohortInsight, InsightKind, InsightOutcome, InsightPoint, InsightsFilter, InsightsOptions, ProviderShare } from '../insights.ts';

type RepositoryRow = {
  repository: string;
  github: string;
  polled_at: string | null;
  last_error: string | null;
  failed_at: string | null;
  branch_rules: string | null;
  own_branch_rules: string | null;
};

type RequestRow = {
  number: number;
  title: string;
  url: string;
  created_at: string;
};

type ClosedRow = {
  number: number;
  title: string;
  url: string;
  parent_number: number | null;
  parent_title: string | null;
  parent_url: string | null;
  created_at: string;
  closed_at: string;
  for_human: number;
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
  for_human: number;
  blocked: number;
  blocked_by: string;
  awaiting_redispatch: number;
};

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


export const RISK_LEVELS = ['trivial', 'low', 'moderate', 'high'] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

export interface RiskGrade {
  repository: string;
  number: number;
  headSha: string;
  fingerprint: string;
  model: string;
  probabilities: Record<RiskLevel, number>;
  score: number;
  confidence: number;
  level: RiskLevel;
  uncertain: boolean;
  costUsd: number;
  gradedAt: string;
}

export interface DisplayedGrade extends RecordedRiskGrade {
  checkPosted: boolean;
  labelsApplied: boolean;
}

export const GRADE_OUTCOMES = ['open', 'merged', 'auto-merged', 'superseded', 'closed'] as const;

export type GradeOutcome = (typeof GRADE_OUTCOMES)[number];

export const SUPERSEDE_CAUSES = ['revision', 'conflict-resolution', 'other', 'unknown'] as const;

export type SupersedeCause = (typeof SUPERSEDE_CAUSES)[number];

export interface RecordedRiskGrade extends RiskGrade {
  outcome: GradeOutcome;
  outcomeAt: string | null;
  revisions: number | null;
  supersedeCause: SupersedeCause | null;
}

export interface GradingAttempt {
  repository: string;
  number: number;
  headSha: string;
  attemptedAt: string;
  category: GradingFailure;
  message: string;
}

export interface GradingStatus {
  lastSucceededAt: string | null;
  failingSince: string | null;
  failure: GradingAttempt | null;
}

const GRADING_FAILURE_SEVERITY: readonly GradingFailure[] = ['setup', 'bug', 'temporary'];

export const notGradedTitle = ({
  category,
  message,
}: Pick<GradingAttempt, 'category' | 'message'>): string =>
  `Not graded: ${message}${RETRIED_GRADING_FAILURES.includes(category) ? ', retrying' : ''}`;

type GradingAttemptRow = {
  repository: string;
  number: number;
  head_sha: string;
  attempted_at: string;
  category: string;
  message: string;
  check_posted: number;
};

const gradingAttemptFromRow = (row: GradingAttemptRow): GradingAttempt => ({
  repository: row.repository,
  number: row.number,
  headSha: row.head_sha,
  attemptedAt: row.attempted_at,
  category: row.category as GradingFailure,
  message: row.message,
});

const LATEST_ATTEMPT_OF_UNGRADED_CURRENT_HEADS = `
  SELECT grading_attempts.* FROM grading_attempts
  ${CURRENT_HEAD_OF_WATCH}
  WHERE grading_attempts.id = (
      SELECT max(id) FROM grading_attempts AS later
      WHERE later.repository = grading_attempts.repository
        AND later.number = grading_attempts.number
        AND later.head_sha = grading_attempts.head_sha
    )
    AND NOT EXISTS (
      SELECT 1 FROM risk_grades
      WHERE risk_grades.repository = grading_attempts.repository
        AND risk_grades.number = grading_attempts.number
        AND risk_grades.head_sha = grading_attempts.head_sha
    )
`;

export interface GradingDue {
  repository: string;
  number: number;
  url: string;
  closes: number[];
  headSha: string;
}

const displayedGradeFromRow = (row: RiskGradeRow): DisplayedGrade => ({
  ...riskGradeFromRow(row),
  checkPosted: row.check_posted === 1,
  labelsApplied: row.labels_applied === 1,
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


const requestFromRow = (row: RequestRow): RefinementRequest => ({
  number: row.number,
  title: row.title,
  url: row.url,
  createdAt: row.created_at,
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
  forHuman: row.for_human === 1,
  blocked: row.blocked === 1,
  blockedBy: JSON.parse(row.blocked_by) as number[],
  ...(row.awaiting_redispatch === 1 ? { awaitingRedispatch: true } : {}),
});

const closedFromRow = (row: ClosedRow): ClosedTicket => ({
  number: row.number,
  title: row.title,
  url: row.url,
  parent:
    row.parent_number === null || row.parent_title === null || row.parent_url === null
      ? null
      : { number: row.parent_number, title: row.parent_title, url: row.parent_url },
  createdAt: row.created_at,
  closedAt: row.closed_at,
  forHuman: row.for_human === 1,
});

export class Store {
  readonly #db: Connection;
  readonly workloads: Workloads;
  readonly runs: Runs;
  readonly autoMerge: AutoMerge;
  readonly urgency: Urgency;

  private constructor(db: Connection) {
    this.#db = db;
    this.runs = new Runs(db);
    this.workloads = new Workloads(db, {
      getRun: (id) => this.runs.getRun(id),
      getFingerprint: (id) => this.runs.getFingerprint(id),
    });
    this.autoMerge = new AutoMerge(db);
    this.urgency = new Urgency(db);
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

  replaceFrontier({ repository, github, polledAt, tickets, closed, requests }: PolledFrontier): void {
    this.#db.transaction(() => {
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
          forge_ready, for_human, blocked, blocked_by, version, awaiting_redispatch
        ) VALUES (
          $repository, $number, $title, $url, $parent_number, $parent_title, $parent_url, $created_at,
          $forge_ready, $for_human, $blocked, $blocked_by, $version, $awaiting_redispatch
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
          for_human: ticket.forHuman ? 1 : 0,
          blocked: ticket.blocked ? 1 : 0,
          blocked_by: JSON.stringify(ticket.blockedBy),
          version: ticket.version ?? '',
          awaiting_redispatch: ticket.awaitingRedispatch === true ? 1 : 0,
        });
      }
      this.#db
        .prepare('DELETE FROM frontier_closed WHERE repository = $repository')
        .run({ repository });
      const insertClosed = this.#db.prepare(
        `INSERT INTO frontier_closed (
          repository, number, title, url, parent_number, parent_title, parent_url, created_at,
          closed_at, for_human
        ) VALUES (
          $repository, $number, $title, $url, $parent_number, $parent_title, $parent_url, $created_at,
          $closed_at, $for_human
        )`,
      );
      for (const ticket of closed) {
        insertClosed.run({
          repository,
          number: ticket.number,
          title: ticket.title,
          url: ticket.url,
          parent_number: ticket.parent?.number ?? null,
          parent_title: ticket.parent?.title ?? null,
          parent_url: ticket.parent?.url ?? null,
          created_at: ticket.createdAt,
          closed_at: ticket.closedAt,
          for_human: ticket.forHuman ? 1 : 0,
        });
      }
      this.#db
        .prepare('DELETE FROM frontier_requests WHERE repository = $repository')
        .run({ repository });
      const insertRequest = this.#db.prepare(
        `INSERT INTO frontier_requests (repository, number, title, url, created_at)
        VALUES ($repository, $number, $title, $url, $created_at)`,
      );
      for (const request of requests) {
        insertRequest.run({
          repository,
          number: request.number,
          title: request.title,
          url: request.url,
          created_at: request.createdAt,
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

  recordBranchRules({
    repository,
    github,
    failures,
    reviewerApp = [],
  }: {
    repository: string;
    github: string;
    failures: string[];
    reviewerApp?: string[];
  }): void {
    this.#db
      .prepare(
        `INSERT INTO frontier_repositories (repository, github, polled_at, last_error, failed_at, branch_rules, own_branch_rules)
        VALUES ($repository, $github, NULL, NULL, NULL, $branch_rules, $own_branch_rules)
        ON CONFLICT (repository) DO UPDATE SET
          github = excluded.github,
          branch_rules = excluded.branch_rules,
          own_branch_rules = excluded.own_branch_rules`,
      )
      .run({
        repository,
        github,
        branch_rules: JSON.stringify([...failures, ...reviewerApp]),
        own_branch_rules: JSON.stringify(failures),
      });
  }

  ownRuleFailures(repository: string): string[] {
    const row = this.#db
      .prepare(`SELECT own_branch_rules FROM frontier_repositories WHERE repository = $repository`)
      .get({ repository }) as { own_branch_rules: string | null } | undefined;
    return row?.own_branch_rules == null ? [] : (JSON.parse(row.own_branch_rules) as string[]);
  }

  recordReviewerAppFailures(repository: string, failures: readonly string[], checkedAt: string): void {
    this.#db
      .prepare(
        `INSERT INTO reviewer_app_checks (repository, failures, checked_at)
        VALUES ($repository, $failures, $checked_at)
        ON CONFLICT (repository) DO UPDATE SET
          failures = excluded.failures,
          checked_at = excluded.checked_at`,
      )
      .run({ repository, failures: JSON.stringify(failures), checked_at: checkedAt });
  }

  reviewerAppFailures(repository: string): string[] {
    const row = this.#db
      .prepare(`SELECT failures FROM reviewer_app_checks WHERE repository = $repository`)
      .get({ repository }) as { failures: string } | undefined;
    return row === undefined ? [] : (JSON.parse(row.failures) as string[]);
  }

  pruneFrontier(declared: string[]): void {
    this.#db
      .prepare(
        `DELETE FROM reviewer_app_checks
        WHERE repository NOT IN (SELECT value FROM json_each($declared))`,
      )
      .run({ declared: JSON.stringify(declared) });
    this.workloads.pruneWatches(declared);
    this.#db
      .prepare(
        `DELETE FROM frontier_repositories
        WHERE repository NOT IN (SELECT value FROM json_each($declared))`,
      )
      .run({ declared: JSON.stringify(declared) });
  }

  listRepositoryProblems(): RepositoryProblems[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM frontier_repositories
        WHERE last_error IS NOT NULL OR branch_rules IS NOT NULL
        ORDER BY repository`,
      )
      .all() as RepositoryRow[];
    return rows.flatMap((row) => {
      const lastError =
        row.last_error === null || row.failed_at === null
          ? null
          : { message: row.last_error, failedAt: row.failed_at };
      const rules = row.branch_rules === null ? [] : (JSON.parse(row.branch_rules) as string[]);
      return lastError === null && rules.length === 0
        ? []
        : [
            {
              repository: row.repository,
              github: row.github,
              lastError,
              branchRules: row.branch_rules === null ? null : rules,
            },
          ];
    });
  }

  listFrontier(): RepositoryFrontier[] {
    const repositories = this.#db
      .prepare('SELECT * FROM frontier_repositories ORDER BY repository')
      .all() as RepositoryRow[];
    const tickets = this.#db.prepare(
      'SELECT * FROM frontier_tickets WHERE repository = $repository',
    );
    const closed = this.#db.prepare(
      'SELECT * FROM frontier_closed WHERE repository = $repository',
    );
    const requests = this.#db.prepare(
      'SELECT * FROM frontier_requests WHERE repository = $repository',
    );
    return repositories.map((row) => ({
      repository: row.repository,
      github: row.github,
      polledAt: row.polled_at,
      lastError:
        row.last_error === null || row.failed_at === null
          ? null
          : { message: row.last_error, failedAt: row.failed_at },
      branchRules: row.branch_rules === null ? null : (JSON.parse(row.branch_rules) as string[]),
      tickets: (tickets.all({ repository: row.repository }) as TicketRow[])
        .map(ticketFromRow)
        .toSorted(oldestFirst),
      closed: (closed.all({ repository: row.repository }) as ClosedRow[])
        .map(closedFromRow)
        .toSorted(newestClosedFirst),
      requests: (requests.all({ repository: row.repository }) as RequestRow[])
        .map(requestFromRow)
        .toSorted(oldestFirst),
    }));
  }

  gradingDue(repositories: readonly string[], now: string): GradingDue[] {
    const rows = this.#db
      .prepare(
        `SELECT repository, number, url, closes, head_sha FROM feedback_watches
        WHERE mergeable IS NOT NULL
          AND head_sha IS NOT NULL
          AND draft = 0
          AND repository IN (SELECT value FROM json_each($repositories))
          AND NOT EXISTS (
            SELECT 1 FROM risk_grades
            WHERE risk_grades.repository = feedback_watches.repository
              AND risk_grades.number = feedback_watches.number
              AND risk_grades.head_sha = feedback_watches.head_sha
          )
          AND NOT ${liveRevisionOn('feedback_watches')}
          AND NOT ${liveConflictResolutionOn('feedback_watches')}
          AND NOT ${liveOpeningDispatchOf('feedback_watches')}
        ORDER BY repository, number`,
      )
      .all({ repositories: JSON.stringify(repositories), live_since: liveSince(now) }) as {
      repository: string;
      number: number;
      url: string;
      closes: string;
      head_sha: string;
    }[];
    return rows
      .filter((row) => !this.#gradingHeldOff(row, now))
      .map((row) => ({
        repository: row.repository,
        number: row.number,
        url: row.url,
        closes: JSON.parse(row.closes) as number[],
        headSha: row.head_sha,
      }));
  }

  #gradingHeldOff(
    head: { repository: string; number: number; head_sha: string },
    now: string,
  ): boolean {
    const latest = this.#db
      .prepare(
        `SELECT category, attempted_at,
          (SELECT count(*) FROM grading_attempts AS every
            WHERE every.repository = latest.repository
              AND every.number = latest.number
              AND every.head_sha = latest.head_sha) AS failures
        FROM grading_attempts AS latest
        WHERE repository = $repository AND number = $number AND head_sha = $head_sha
        ORDER BY id DESC LIMIT 1`,
      )
      .get({
        repository: head.repository,
        number: head.number,
        head_sha: head.head_sha,
      }) as LatestAttempt | undefined;
    return latest !== undefined && attemptHoldsOff(latest, now);
  }

  recordGradingAttempt(attempt: GradingAttempt): void {
    const previous = this.#db
      .prepare(
        `SELECT category, message, check_posted FROM grading_attempts
        WHERE repository = $repository AND number = $number AND head_sha = $head_sha
        ORDER BY id DESC LIMIT 1`,
      )
      .get({
        repository: attempt.repository,
        number: attempt.number,
        head_sha: attempt.headSha,
      }) as { category: string; message: string; check_posted: number } | undefined;
    const repeated =
      previous !== undefined &&
      previous.check_posted === 1 &&
      previous.category === attempt.category &&
      previous.message === attempt.message;
    this.#db
      .prepare(
        `INSERT INTO grading_attempts (
          repository, number, head_sha, attempted_at, category, message, check_posted
        ) VALUES (
          $repository, $number, $head_sha, $attempted_at, $category, $message, $check_posted
        )`,
      )
      .run({
        repository: attempt.repository,
        number: attempt.number,
        head_sha: attempt.headSha,
        attempted_at: attempt.attemptedAt,
        category: attempt.category,
        message: attempt.message,
        check_posted: repeated ? 1 : 0,
      });
  }

  attemptsAwaitingCheck(repositories: readonly string[]): GradingAttempt[] {
    const rows = this.#db
      .prepare(
        `${LATEST_ATTEMPT_OF_UNGRADED_CURRENT_HEADS}
          AND grading_attempts.check_posted = 0
          AND grading_attempts.repository IN (SELECT value FROM json_each($repositories))
        ORDER BY grading_attempts.repository, grading_attempts.number`,
      )
      .all({ repositories: JSON.stringify(repositories) }) as GradingAttemptRow[];
    return rows.map(gradingAttemptFromRow);
  }

  markAttemptCheckPosted(attempt: GradingAttempt): void {
    this.#db
      .prepare(
        `UPDATE grading_attempts SET check_posted = 1
        WHERE repository = $repository AND number = $number AND head_sha = $head_sha
          AND attempted_at = $attempted_at`,
      )
      .run({
        repository: attempt.repository,
        number: attempt.number,
        head_sha: attempt.headSha,
        attempted_at: attempt.attemptedAt,
      });
  }

  currentGradingAttempts(): GradingAttempt[] {
    const rows = this.#db
      .prepare(
        `${LATEST_ATTEMPT_OF_UNGRADED_CURRENT_HEADS}
        ORDER BY grading_attempts.repository, grading_attempts.number`,
      )
      .all() as GradingAttemptRow[];
    return rows.map(gradingAttemptFromRow);
  }

  gradingStatus(): GradingStatus {
    const succeeded = this.#db
      .prepare('SELECT max(graded_at) AS at FROM risk_grades')
      .get() as { at: string | null };
    const failing = this.currentGradingAttempts()
      .filter(({ category }) => RETRIED_GRADING_FAILURES.includes(category))
      .toSorted(
        (a, b) =>
          GRADING_FAILURE_SEVERITY.indexOf(a.category) - GRADING_FAILURE_SEVERITY.indexOf(b.category) ||
          (a.attemptedAt < b.attemptedAt ? 1 : -1),
      );
    if (failing.length === 0) return { lastSucceededAt: succeeded.at, failingSince: null, failure: null };
    const firstFailed = this.#db
      .prepare(
        `SELECT min(attempted_at) AS at FROM grading_attempts
        WHERE category IN (SELECT value FROM json_each($categories))
          AND (repository, number, head_sha) IN (
            SELECT value ->> 0, value ->> 1, value ->> 2 FROM json_each($heads))`,
      )
      .get({
        categories: JSON.stringify(RETRIED_GRADING_FAILURES),
        heads: JSON.stringify(failing.map(({ repository, number, headSha }) => [repository, number, headSha])),
      }) as { at: string };
    return { lastSucceededAt: succeeded.at, failingSince: succeeded.at === null || firstFailed.at < succeeded.at ? firstFailed.at : succeeded.at, failure: failing[0]! };
  }

  currentRiskGrades(): RecordedRiskGrade[] {
    const rows = this.#db
      .prepare(
        `SELECT risk_grades.* FROM risk_grades
        ${CURRENT_HEAD_OF_WATCH}
        ORDER BY risk_grades.repository, risk_grades.number`,
      )
      .all() as RiskGradeRow[];
    return rows.map(riskGradeFromRow);
  }

  riskOptions(): RiskOptions {
    const column = (sql: string): string[] =>
      (this.#db.prepare(sql).all() as { value: string }[]).map(({ value }) => value);
    return {
      cohorts: column(
        'SELECT fingerprint AS value FROM risk_grades GROUP BY fingerprint ORDER BY max(graded_at) DESC, fingerprint',
      ),
      repositories: column('SELECT DISTINCT repository AS value FROM risk_grades ORDER BY repository'),
    };
  }

  listRiskGrades(filter: RiskFilter): RecordedRiskGrade[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM risk_grades
        WHERE fingerprint = $fingerprint
          AND ($repository IS NULL OR repository = $repository)
          AND ($graded_from IS NULL OR graded_at >= $graded_from)
          AND ($graded_before IS NULL OR graded_at < $graded_before)
        ORDER BY graded_at, repository, number`,
      )
      .all({
        fingerprint: filter.fingerprint,
        repository: filter.repository ?? null,
        graded_from: filter.gradedFrom ?? null,
        graded_before: filter.gradedBefore ?? null,
      }) as RiskGradeRow[];
    return rows.map(riskGradeFromRow);
  }

  listFailedGradingHeads(filter: Omit<RiskFilter, 'fingerprint'>): GradingFailure[] {
    const rows = this.#db
      .prepare(
        `SELECT grading_attempts.category FROM grading_attempts
        WHERE grading_attempts.id = (
            SELECT max(id) FROM grading_attempts AS later
            WHERE later.repository = grading_attempts.repository
              AND later.number = grading_attempts.number
              AND later.head_sha = grading_attempts.head_sha
          )
          AND NOT EXISTS (
            SELECT 1 FROM risk_grades
            WHERE risk_grades.repository = grading_attempts.repository
              AND risk_grades.number = grading_attempts.number
              AND risk_grades.head_sha = grading_attempts.head_sha
          )
          AND ($repository IS NULL OR grading_attempts.repository = $repository)
          AND ($attempted_from IS NULL OR grading_attempts.attempted_at >= $attempted_from)
          AND ($attempted_before IS NULL OR grading_attempts.attempted_at < $attempted_before)`,
      )
      .all({
        repository: filter.repository ?? null,
        attempted_from: filter.gradedFrom ?? null,
        attempted_before: filter.gradedBefore ?? null,
      }) as { category: string }[];
    return rows.map(({ category }) => category as GradingFailure);
  }

  gradesAwaitingDisplay(repositories: readonly string[]): DisplayedGrade[] {
    const rows = this.#db
      .prepare(
        `SELECT risk_grades.* FROM risk_grades
        ${CURRENT_HEAD_OF_WATCH}
        WHERE (risk_grades.check_posted = 0 OR risk_grades.labels_applied = 0)
          AND feedback_watches.mergeable IS NOT NULL
          AND risk_grades.repository IN (SELECT value FROM json_each($repositories))
        ORDER BY risk_grades.repository, risk_grades.number`,
      )
      .all({ repositories: JSON.stringify(repositories) }) as RiskGradeRow[];
    return rows.map(displayedGradeFromRow);
  }

  gradesWithStaleLabels(repositories: readonly string[]): DisplayedGrade[] {
    const rows = this.#db
      .prepare(
        `SELECT risk_grades.* FROM risk_grades
        JOIN feedback_watches USING (repository, number)
        WHERE risk_grades.labels_applied = 1
          AND feedback_watches.mergeable IS NOT NULL
          AND feedback_watches.head_sha IS NOT NULL
          AND feedback_watches.head_sha <> risk_grades.head_sha
          AND risk_grades.repository IN (SELECT value FROM json_each($repositories))
        ORDER BY risk_grades.repository, risk_grades.number`,
      )
      .all({ repositories: JSON.stringify(repositories) }) as RiskGradeRow[];
    return rows.map(displayedGradeFromRow);
  }

  markCheckPosted(grade: Pick<RiskGrade, 'repository' | 'number' | 'headSha'>): void {
    this.#db
      .prepare(
        `UPDATE risk_grades SET check_posted = 1
        WHERE repository = $repository AND number = $number AND head_sha = $head_sha`,
      )
      .run({ repository: grade.repository, number: grade.number, head_sha: grade.headSha });
  }

  markLabelsApplied(
    grade: Pick<RiskGrade, 'repository' | 'number' | 'headSha'>,
    applied: boolean,
  ): void {
    this.#db.transaction(() => {
      this.#db
        .prepare(
          `UPDATE risk_grades SET labels_applied = 0
          WHERE repository = $repository AND number = $number`,
        )
        .run({ repository: grade.repository, number: grade.number });
      if (!applied) return;
      this.#db
        .prepare(
          `UPDATE risk_grades SET labels_applied = 1
          WHERE repository = $repository AND number = $number AND head_sha = $head_sha`,
        )
        .run({ repository: grade.repository, number: grade.number, head_sha: grade.headSha });
    });
  }

  recordRiskGrade(grade: RiskGrade): void {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO risk_grades (
          repository, number, head_sha, fingerprint, model, probabilities,
          score, confidence, level, uncertain, cost_usd, graded_at
        ) VALUES (
          $repository, $number, $head_sha, $fingerprint, $model, $probabilities,
          $score, $confidence, $level, $uncertain, $cost_usd, $graded_at
        )`,
      )
      .run({
        repository: grade.repository,
        number: grade.number,
        head_sha: grade.headSha,
        fingerprint: grade.fingerprint,
        model: grade.model,
        probabilities: JSON.stringify(grade.probabilities),
        score: grade.score,
        confidence: grade.confidence,
        level: grade.level,
        uncertain: grade.uncertain ? 1 : 0,
        cost_usd: grade.costUsd,
        graded_at: grade.gradedAt,
      });
  }

  openRiskGrades(repository: string): RecordedRiskGrade[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM risk_grades
        WHERE repository = $repository AND outcome = 'open'
        ORDER BY number, graded_at`,
      )
      .all({ repository }) as RiskGradeRow[];
    return rows.map(riskGradeFromRow);
  }

  read<Row>(sql: string, parameters: Record<string, SQLInputValue> = {}): Row[] {
    return this.#db.prepare(sql).all(parameters) as Row[];
  }

  settleRiskGrade(
    grade: Pick<RiskGrade, 'repository' | 'number' | 'headSha'>,
    outcome: Exclude<GradeOutcome, 'open'>,
    at: string,
    supersededBy?: string,
  ): void {
    this.#db
      .prepare(
        `UPDATE risk_grades SET
          outcome = CASE
            WHEN $outcome = 'merged' AND auto_merge_started_at IS NOT NULL THEN 'auto-merged'
            ELSE $outcome
          END,
          outcome_at = $at,
          revisions = (
            SELECT COUNT(*) FROM revisions
            WHERE revisions.repository = risk_grades.repository
              AND revisions.number = risk_grades.number
              AND revisions.state = 'done'
              AND revisions.started_at >= risk_grades.graded_at
              AND revisions.started_at <= $at
          ),
          supersede_cause = CASE WHEN $outcome = 'superseded' THEN
            CASE
              WHEN $superseded_by IS NULL THEN 'unknown'
              WHEN EXISTS (
                SELECT 1 FROM revisions
                WHERE revisions.repository = risk_grades.repository
                  AND revisions.number = risk_grades.number
                  AND revisions.pushed_sha = $superseded_by
              ) THEN 'revision'
              WHEN EXISTS (
                SELECT 1 FROM conflict_resolutions
                WHERE conflict_resolutions.repository = risk_grades.repository
                  AND conflict_resolutions.number = risk_grades.number
                  AND conflict_resolutions.pushed_sha = $superseded_by
              ) THEN 'conflict-resolution'
              ELSE 'other'
            END
          END
        WHERE repository = $repository AND number = $number AND head_sha = $head_sha
          AND outcome = 'open'`,
      )
      .run({
        outcome,
        at,
        superseded_by: supersededBy ?? null,
        repository: grade.repository,
        number: grade.number,
        head_sha: grade.headSha,
      });
  }

  riskGrade(repository: string, number: number, headSha: string): RecordedRiskGrade | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM risk_grades
        WHERE repository = $repository AND number = $number AND head_sha = $head_sha`,
      )
      .get({ repository, number, head_sha: headSha }) as RiskGradeRow | undefined;
    return row === undefined ? null : riskGradeFromRow(row);
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
