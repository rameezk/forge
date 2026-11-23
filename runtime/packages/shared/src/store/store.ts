import type { SQLInputValue } from 'node:sqlite';
import { openConnection, type Connection } from './connection.ts';
import { migrate } from './migrate.ts';
import { Diagnoses, LATEST_DIAGNOSIS_CATEGORY, NOT_A_DIAGNOSIS } from './diagnoses.ts';
import { boundedDetail, liveSince } from './fragments.ts';
import { Runs } from './runs.ts';
import type { AutoMergeVerdict, CheckRunConclusion, FailingGate, RecordedAutoMergeVerdict } from '../auto-merge-verdict.ts';
import {
  newestClosedFirst,
  oldestFirst,
  type ClosedTicket,
  type PolledFrontier,
  type PollFailure,
  type RepositoryProblems,
  type RefinementRequest,
  type RepositoryFrontier,
  type Ticket,
} from '../frontier.ts';
import {
  ticketKey,
  type DispatchFailure,
  type DispatchOutcome,
  type DispatchRecord,
  type DispatchStart,
  type DispatchState,
  type DispatchTicket,
  type PullRequestRecord,
  type PullRequestState,
} from '../dispatch.ts';
import type {
  ConflictResolutionFailure,
  ConflictResolutionFailureRecord,
  ConflictResolutionRecord,
  ConflictResolutionStart,
  ConflictResolutionState,
  RunPullRequestWorkload,
  ShaPair,
} from '../conflict-resolution.ts';
import type {
  RevisedPullRequest,
  RevisionFailure,
  RevisionFailureRecord,
  RevisionRecord,
  RevisionStart,
  RevisionState,
} from '../revision.ts';
import type { WatchedPullRequest } from '../feedback.ts';
import type { AttemptConflictResolution, AttemptRevision, TicketAttempt } from '../attempts.ts';
import type { AutoMergeCounts } from '../auto-merge-status.ts';
import type { ConfigFingerprint } from '../fingerprint.ts';
import type { DiagnosisCategory } from '../diagnosis.ts';
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

type DispatchRow = {
  id: number;
  repository: string;
  number: number;
  url: string;
  run_id: string | null;
  state: string;
  reason: string | null;
  detail: string | null;
  failed_starts: number | null;
  started_at: string;
  alive_at: string;
  ended_at: string | null;
  pr_number: number | null;
  pr_url: string | null;
  pr_state: string | null;
  pr_settled_at: string | null;
  pr_rework: number | null;
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

type RevisionRow = {
  id: number;
  repository: string;
  number: number;
  url: string;
  run_id: string | null;
  dispatch_id: number | null;
  state: string;
  reason: string | null;
  detail: string | null;
  failed_starts: number | null;
  feedback_cursor: string | null;
  started_at: string;
  alive_at: string;
  ended_at: string | null;
};

type ConflictResolutionRow = {
  id: number;
  repository: string;
  number: number;
  url: string;
  run_id: string | null;
  dispatch_id: number | null;
  state: string;
  reason: string | null;
  detail: string | null;
  failed_starts: number | null;
  head_sha: string | null;
  default_sha: string | null;
  started_at: string;
  alive_at: string;
  ended_at: string | null;
};

const conflictResolutionFromRow = (row: ConflictResolutionRow): ConflictResolutionRecord => ({
  id: row.id,
  repository: row.repository,
  number: row.number,
  url: row.url,
  runId: row.run_id,
  dispatchId: row.dispatch_id,
  state: row.state as ConflictResolutionState,
  reason: row.reason as ConflictResolutionFailure | null,
  detail: row.detail,
  failedStarts: row.failed_starts,
  startedAt: row.started_at,
  aliveAt: row.alive_at,
  endedAt: row.ended_at,
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

export const URGENCY_LEVELS = ['critical', 'high', 'normal', 'low'] as const;

export type UrgencyLevel = (typeof URGENCY_LEVELS)[number];

export interface UrgencyGrade {
  repository: string;
  number: number;
  version: string;
  fingerprint: string;
  model: string;
  probabilities: Record<UrgencyLevel, number>;
  score: number;
  confidence: number;
  level: UrgencyLevel;
  uncertain: boolean;
  costUsd: number;
  gradedAt: string;
}

export interface UrgencyAttempt {
  repository: string;
  number: number;
  version: string;
  attemptedAt: string;
  category: GradingFailure;
  message: string;
}

export interface UrgencyDue {
  repository: string;
  number: number;
  version: string;
}

export interface DisplayedUrgencyGrade extends UrgencyGrade {
  labelsApplied: boolean;
}

type UrgencyGradeRow = {
  repository: string;
  number: number;
  version: string;
  fingerprint: string;
  model: string;
  probabilities: string;
  score: number;
  confidence: number;
  level: string;
  uncertain: number;
  cost_usd: number;
  graded_at: string;
  labels_applied: number;
};

type UrgencyAttemptRow = {
  repository: string;
  number: number;
  version: string;
  attempted_at: string;
  category: string;
  message: string;
};

const urgencyAttemptFromRow = (row: UrgencyAttemptRow): UrgencyAttempt => ({
  repository: row.repository,
  number: row.number,
  version: row.version,
  attemptedAt: row.attempted_at,
  category: row.category as GradingFailure,
  message: row.message,
});

const urgencyGradeFromRow = (row: UrgencyGradeRow): DisplayedUrgencyGrade => ({
  repository: row.repository,
  number: row.number,
  version: row.version,
  fingerprint: row.fingerprint,
  model: row.model,
  probabilities: JSON.parse(row.probabilities) as Record<UrgencyLevel, number>,
  score: row.score,
  confidence: row.confidence,
  level: row.level as UrgencyLevel,
  uncertain: row.uncertain === 1,
  costUsd: row.cost_usd,
  gradedAt: row.graded_at,
  labelsApplied: row.labels_applied === 1,
});

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

export const GRADING_FAILURES = ['temporary', 'setup', 'too-large', 'declined', 'bug'] as const;

export type GradingFailure = (typeof GRADING_FAILURES)[number];

export const RETRIED_GRADING_FAILURES: readonly GradingFailure[] = ['temporary', 'setup', 'bug'];

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

const GRADING_RETRY_BASE_MS = 30_000;

const GRADING_RETRY_CAP_MS = 3_600_000;

export const notGradedTitle = ({
  category,
  message,
}: Pick<GradingAttempt, 'category' | 'message'>): string =>
  `Not graded: ${message}${RETRIED_GRADING_FAILURES.includes(category) ? ', retrying' : ''}`;

export const gradingRetryDelayMs = (failures: number): number =>
  Math.min(GRADING_RETRY_BASE_MS * 2 ** Math.min(failures - 1, 16), GRADING_RETRY_CAP_MS);

interface LatestAttempt {
  category: string;
  attempted_at: string;
  failures: number;
}

const attemptHoldsOff = (latest: LatestAttempt, now: string): boolean =>
  !RETRIED_GRADING_FAILURES.includes(latest.category as GradingFailure) ||
  Date.parse(now) < Date.parse(latest.attempted_at) + gradingRetryDelayMs(latest.failures);

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
  JOIN feedback_watches
    ON feedback_watches.repository = grading_attempts.repository
    AND feedback_watches.number = grading_attempts.number
    AND feedback_watches.head_sha = grading_attempts.head_sha
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

export type RiskGradeRow = {
  repository: string;
  number: number;
  head_sha: string;
  fingerprint: string;
  model: string;
  probabilities: string;
  score: number;
  confidence: number;
  level: string;
  uncertain: number;
  cost_usd: number;
  graded_at: string;
  check_posted: number;
  labels_applied: number;
  outcome: string;
  outcome_at: string | null;
  revisions: number | null;
  supersede_cause: string | null;
};

const displayedGradeFromRow = (row: RiskGradeRow): DisplayedGrade => ({
  ...riskGradeFromRow(row),
  checkPosted: row.check_posted === 1,
  labelsApplied: row.labels_applied === 1,
});

export const riskGradeFromRow = (row: RiskGradeRow): RecordedRiskGrade => ({
  repository: row.repository,
  number: row.number,
  headSha: row.head_sha,
  fingerprint: row.fingerprint,
  model: row.model,
  probabilities: JSON.parse(row.probabilities) as Record<RiskLevel, number>,
  score: row.score,
  confidence: row.confidence,
  level: row.level as RiskLevel,
  uncertain: row.uncertain === 1,
  costUsd: row.cost_usd,
  gradedAt: row.graded_at,
  outcome: row.outcome as GradeOutcome,
  outcomeAt: row.outcome_at,
  revisions: row.revisions,
  supersedeCause: row.supersede_cause as SupersedeCause | null,
});

type FeedbackWatchRow = {
  repository: string;
  number: number;
  url: string;
  closes: string;
};

const revisionFromRow = (row: RevisionRow): RevisionRecord => ({
  id: row.id,
  repository: row.repository,
  number: row.number,
  url: row.url,
  runId: row.run_id,
  dispatchId: row.dispatch_id,
  state: row.state as RevisionState,
  reason: row.reason as RevisionFailure | null,
  detail: row.detail,
  failedStarts: row.failed_starts,
  startedAt: row.started_at,
  aliveAt: row.alive_at,
  endedAt: row.ended_at,
});

const dispatchFromRow = (row: DispatchRow): DispatchRecord => ({
  id: row.id,
  repository: row.repository,
  number: row.number,
  url: row.url,
  runId: row.run_id,
  state: row.state as DispatchState,
  reason: row.reason as DispatchFailure | null,
  detail: row.detail,
  failedStarts: row.failed_starts,
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
  readonly runs: Runs;
  readonly diagnoses: Diagnoses;

  private constructor(db: Connection) {
    this.#db = db;
    this.runs = new Runs(db);
    this.diagnoses = new Diagnoses(db);
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
          ${LATEST_DIAGNOSIS_CATEGORY} AS diagnosis
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

  listAttempts(ticket: { repository: string; number: number }, now: string): TicketAttempt[] {
    const rows = this.#db
      .prepare(
        `SELECT d.id AS id, d.run_id AS run_id FROM dispatches d
        JOIN runs r ON r.id = d.run_id
        WHERE d.repository = $repository AND d.number = $number
        ORDER BY d.id DESC`,
      )
      .all({ repository: ticket.repository, number: ticket.number }) as { id: number; run_id: string }[];
    return rows.map(({ id, run_id }) => ({
      run: this.runs.getRun(run_id)!,
      config: this.runs.getFingerprint(run_id),
      pullRequest: this.pullRequestOfRun(run_id),
      revisions: this.#revisionsOf(id, now),
      conflictResolutions: this.#conflictResolutionsOf(id, now),
    }));
  }

  attemptedTickets(): Set<string> {
    const rows = this.#db
      .prepare(
        `SELECT DISTINCT d.repository AS repository, d.number AS number FROM dispatches d
        JOIN runs r ON r.id = d.run_id`,
      )
      .all() as { repository: string; number: number }[];
    return new Set(rows.map(({ repository, number }) => ticketKey(repository, number)));
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
    this.#db
      .prepare(
        `DELETE FROM feedback_watches
        WHERE repository NOT IN (SELECT value FROM json_each($declared))`,
      )
      .run({ declared: JSON.stringify(declared) });
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

  recordFailedStart(ticket: DispatchTicket, detail: string, at: string): void {
    this.#db.transaction(() => {
      const latest = this.#latestDispatch(ticket);
      if (latest?.state === 'running') {
        if (latest.alive_at >= liveSince(at)) return;
        this.#interruptStale(latest, at);
      }
      if (latest?.state === 'failed' && latest.reason === 'not-started') {
        this.#db
          .prepare(
            `UPDATE dispatches SET
              detail = $detail, failed_starts = COALESCE(failed_starts, 0) + 1,
              started_at = $at, alive_at = $at, ended_at = $at
            WHERE id = $id`,
          )
          .run({ id: latest.id, detail: boundedDetail(detail), at });
        return;
      }
      const id = this.#insertDispatch(ticket, null, 'failed', 'not-started', at);
      this.#db
        .prepare(`UPDATE dispatches SET detail = $detail, failed_starts = 1 WHERE id = $id`)
        .run({ id, detail: boundedDetail(detail) });
    });
  }

  liveWorkloads(now: string): number {
    const { live } = this.#db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM dispatches WHERE state = 'running' AND alive_at >= $live_since)
          + (SELECT COUNT(*) FROM revisions WHERE state = 'running' AND alive_at >= $live_since)
          + (SELECT COUNT(*) FROM conflict_resolutions WHERE state = 'running' AND alive_at >= $live_since)
          AS live`,
      )
      .get({ live_since: liveSince(now) }) as { live: number };
    return live;
  }

  reviewSlotsTaken(now: string): { pullRequests: number; running: number } {
    return this.#db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM dispatches WHERE pr_state = 'open') AS pullRequests,
          (SELECT COUNT(*) FROM dispatches WHERE state = 'running' AND alive_at >= $live_since) AS running`,
      )
      .get({ live_since: liveSince(now) }) as { pullRequests: number; running: number };
  }

  dispatchesInReview(now: string): number {
    const { pullRequests, running } = this.reviewSlotsTaken(now);
    return pullRequests + running;
  }

  startDispatch(
    ticket: DispatchTicket,
    runId: string,
    startedAt: string,
    maxConcurrent: number,
    maxOpenPullRequests: number | null,
  ): DispatchStart {
    let start: DispatchStart = { refused: 'dispatching' };
    this.#db.transaction(() => {
      const latest = this.#latestDispatch(ticket);
      if (latest?.state === 'running' && latest.alive_at >= liveSince(startedAt)) return;
      const live = this.liveWorkloads(startedAt);
      if (live >= maxConcurrent) {
        start = { refused: 'full', live };
        return;
      }
      if (maxOpenPullRequests !== null) {
        const open = this.dispatchesInReview(startedAt);
        if (open >= maxOpenPullRequests) {
          start = { refused: 'review-limit', open };
          return;
        }
      }
      if (latest?.state === 'running') this.#interruptStale(latest, startedAt);
      start = { started: this.#insertDispatch(ticket, runId, 'running', null, startedAt) };
    });
    return start;
  }

  #latestRevision(pullRequest: Pick<RevisedPullRequest, 'repository' | 'number'>): RevisionRow | undefined {
    return this.#db
      .prepare(
        `SELECT * FROM revisions
        WHERE repository = $repository AND number = $number
        ORDER BY id DESC LIMIT 1`,
      )
      .get({ repository: pullRequest.repository, number: pullRequest.number }) as
      | RevisionRow
      | undefined;
  }

  #revisionLive(pullRequest: Pick<RevisedPullRequest, 'repository' | 'number'>, now: string): boolean {
    const latest = this.#latestRevision(pullRequest);
    return latest?.state === 'running' && latest.alive_at >= liveSince(now);
  }

  #latestConflictResolution(pullRequest: Pick<RevisedPullRequest, 'repository' | 'number'>): ConflictResolutionRow | undefined {
    return this.#db
      .prepare(
        `SELECT * FROM conflict_resolutions
        WHERE repository = $repository AND number = $number
        ORDER BY id DESC LIMIT 1`,
      )
      .get({ repository: pullRequest.repository, number: pullRequest.number }) as
      | ConflictResolutionRow
      | undefined;
  }

  #conflictResolutionLive(pullRequest: Pick<RevisedPullRequest, 'repository' | 'number'>, now: string): boolean {
    const latest = this.#latestConflictResolution(pullRequest);
    return latest?.state === 'running' && latest.alive_at >= liveSince(now);
  }

  #openingDispatchLive(
    pullRequest: RevisedPullRequest,
    tickets: readonly number[],
    now: string,
  ): boolean {
    const latest = this.#db.prepare(
      `SELECT state, alive_at FROM dispatches
      WHERE repository = $repository AND number = $number
      ORDER BY id DESC LIMIT 1`,
    );
    return tickets.some((number) => {
      const row = latest.get({ repository: pullRequest.repository, number }) as
        | { state: string; alive_at: string }
        | undefined;
      return row?.state === 'running' && row.alive_at >= liveSince(now);
    });
  }

  #openingDispatchId(pullRequest: RevisedPullRequest): number | null {
    const opening = this.#db
      .prepare(
        `SELECT id FROM dispatches
        WHERE repository = $repository AND pr_number = $number
        ORDER BY id DESC LIMIT 1`,
      )
      .get({ repository: pullRequest.repository, number: pullRequest.number }) as
      | { id: number }
      | undefined;
    return opening?.id ?? null;
  }

  #feedbackCursor(pullRequest: RevisedPullRequest): string | null {
    const row = this.#db
      .prepare(`SELECT cursor FROM feedback_watches WHERE repository = $repository AND number = $number`)
      .get({ repository: pullRequest.repository, number: pullRequest.number }) as
      | { cursor: string | null }
      | undefined;
    return row?.cursor ?? null;
  }

  #giveFeedbackBack(id: number): void {
    this.#db
      .prepare(
        `UPDATE feedback_watches SET
          cursor = revisions.feedback_cursor,
          newest = NULL,
          held = revisions.started_at
        FROM revisions
        WHERE revisions.id = $id
          AND feedback_watches.repository = revisions.repository
          AND feedback_watches.number = revisions.number`,
      )
      .run({ id });
  }

  startRevision(
    pullRequest: RevisedPullRequest,
    openedBy: readonly number[],
    runId: string,
    startedAt: string,
    maxConcurrent: number,
  ): RevisionStart {
    let start: RevisionStart = { refused: 'revising' };
    this.#db.transaction(() => {
      const latest = this.#latestRevision(pullRequest);
      if (this.#revisionLive(pullRequest, startedAt)) return;
      if (this.#conflictResolutionLive(pullRequest, startedAt)) {
        start = { refused: 'resolving' };
        return;
      }
      if (this.#openingDispatchLive(pullRequest, openedBy, startedAt)) {
        start = { refused: 'dispatching' };
        return;
      }
      const live = this.liveWorkloads(startedAt);
      if (live >= maxConcurrent) {
        start = { refused: 'full', live };
        return;
      }
      if (latest?.state === 'running') {
        this.#db
          .prepare(
            `UPDATE revisions SET state = 'failed', reason = 'interrupted', ended_at = $ended_at WHERE id = $id`,
          )
          .run({ id: latest.id, ended_at: startedAt });
        this.#giveFeedbackBack(latest.id);
      }
      const after = this.#feedbackCursor(pullRequest);
      const row = this.#db
        .prepare(
          `INSERT INTO revisions (
            repository, number, url, run_id, dispatch_id, state, started_at, alive_at, feedback_cursor
          ) VALUES (
            $repository, $number, $url, $run_id, $dispatch_id, 'running', $now, $now, $after
          )
          RETURNING id`,
        )
        .get({
          repository: pullRequest.repository,
          number: pullRequest.number,
          url: pullRequest.url,
          run_id: runId,
          dispatch_id: this.#openingDispatchId(pullRequest),
          now: startedAt,
          after,
        }) as { id: number };
      this.#db
        .prepare(
          `INSERT INTO feedback_watches (repository, number, url, closes, cursor)
          VALUES ($repository, $number, $url, $closes, $now)
          ON CONFLICT (repository, number) DO UPDATE SET
            cursor = $now,
            held = NULL,
            newest = CASE
              WHEN newest IS NOT NULL AND unixepoch(newest) > unixepoch($now) THEN newest
            END`,
        )
        .run({
          repository: pullRequest.repository,
          number: pullRequest.number,
          url: pullRequest.url,
          closes: JSON.stringify(openedBy),
          now: startedAt,
        });
      start = { started: row.id, after };
    });
    return start;
  }

  startConflictResolution(
    pullRequest: RevisedPullRequest,
    openedBy: readonly number[],
    runId: string,
    startedAt: string,
    maxConcurrent: number,
    pair: ShaPair,
  ): ConflictResolutionStart {
    let start: ConflictResolutionStart = { refused: 'resolving' };
    this.#db.transaction(() => {
      const latest = this.#latestConflictResolution(pullRequest);
      if (this.#conflictResolutionLive(pullRequest, startedAt)) return;
      if (this.#revisionLive(pullRequest, startedAt)) {
        start = { refused: 'revising' };
        return;
      }
      if (this.#openingDispatchLive(pullRequest, openedBy, startedAt)) {
        start = { refused: 'dispatching' };
        return;
      }
      const live = this.liveWorkloads(startedAt);
      if (live >= maxConcurrent) {
        start = { refused: 'full', live };
        return;
      }
      if (latest?.state === 'running') {
        this.#db
          .prepare(
            `UPDATE conflict_resolutions SET state = 'failed', reason = 'interrupted', ended_at = $ended_at WHERE id = $id`,
          )
          .run({ id: latest.id, ended_at: startedAt });
      }
      const row = this.#db
        .prepare(
          `INSERT INTO conflict_resolutions (
            repository, number, url, run_id, dispatch_id, state, started_at, alive_at, head_sha, default_sha
          ) VALUES (
            $repository, $number, $url, $run_id, $dispatch_id, 'running', $now, $now, $head_sha, $default_sha
          )
          RETURNING id`,
        )
        .get({
          repository: pullRequest.repository,
          number: pullRequest.number,
          url: pullRequest.url,
          run_id: runId,
          dispatch_id: this.#openingDispatchId(pullRequest),
          now: startedAt,
          head_sha: pair.headSha,
          default_sha: pair.defaultSha,
        }) as { id: number };
      start = { started: row.id };
    });
    return start;
  }

  recordConflictResolutionPush(id: number, headSha: string): void {
    this.#db
      .prepare(`UPDATE conflict_resolutions SET pushed_sha = $head_sha WHERE id = $id`)
      .run({ id, head_sha: headSha });
  }

  touchConflictResolution(id: number, now: string): void {
    this.#db
      .prepare(`UPDATE conflict_resolutions SET alive_at = $now WHERE id = $id AND state = 'running'`)
      .run({ id, now });
  }

  endConflictResolution(
    id: number,
    state: Exclude<ConflictResolutionState, 'running'>,
    endedAt: string,
    failure?: ConflictResolutionFailureRecord,
  ): void {
    this.#db
      .prepare(
        `UPDATE conflict_resolutions SET
          state = $state, reason = $reason, detail = $detail, ended_at = $ended_at
        WHERE id = $id`,
      )
      .run({
        id,
        state,
        reason: failure?.reason ?? null,
        detail: boundedDetail(failure?.detail ?? null),
        ended_at: endedAt,
      });
  }

  recordConflictResolutionStartFailure(
    pullRequest: RevisedPullRequest,
    detail: string,
    at: string,
  ): void {
    this.#db.transaction(() => {
      if (this.#conflictResolutionLive(pullRequest, at)) return;
      const latest = this.#latestConflictResolution(pullRequest);
      if (latest?.reason === 'not-started') {
        this.#db
          .prepare(
            `UPDATE conflict_resolutions SET
              detail = $detail, failed_starts = COALESCE(failed_starts, 0) + 1,
              started_at = $at, alive_at = $at, ended_at = $at
            WHERE id = $id`,
          )
          .run({ id: latest.id, detail: boundedDetail(detail), at });
        return;
      }
      this.#db
        .prepare(
          `INSERT INTO conflict_resolutions (
            repository, number, url, run_id, dispatch_id, state, reason, detail, failed_starts,
            started_at, alive_at, ended_at
          ) VALUES (
            $repository, $number, $url, NULL, $dispatch_id, 'failed', 'not-started', $detail, 1,
            $at, $at, $at
          )`,
        )
        .run({
          repository: pullRequest.repository,
          number: pullRequest.number,
          url: pullRequest.url,
          dispatch_id: this.#openingDispatchId(pullRequest),
          detail: boundedDetail(detail),
          at,
        });
    });
  }

  failConflictResolutionStart(id: number, detail: string, at: string): void {
    this.#db.transaction(() => {
      const row = this.#db
        .prepare(`SELECT * FROM conflict_resolutions WHERE id = $id`)
        .get({ id }) as ConflictResolutionRow | undefined;
      if (row === undefined) return;
      const previous = this.#db
        .prepare(
          `SELECT id, reason FROM conflict_resolutions
          WHERE repository = $repository AND number = $number AND id < $id
          ORDER BY id DESC LIMIT 1`,
        )
        .get({ repository: row.repository, number: row.number, id }) as
        | { id: number; reason: string | null }
        | undefined;
      if (previous?.reason === 'not-started') {
        this.#db
          .prepare(
            `UPDATE conflict_resolutions SET
              detail = $detail, failed_starts = COALESCE(failed_starts, 0) + 1,
              started_at = $at, alive_at = $at, ended_at = $at,
              head_sha = $head_sha, default_sha = $default_sha
            WHERE id = $id`,
          )
          .run({
            id: previous.id,
            detail: boundedDetail(detail),
            at,
            head_sha: row.head_sha,
            default_sha: row.default_sha,
          });
        this.#db.prepare(`DELETE FROM conflict_resolutions WHERE id = $id`).run({ id });
        return;
      }
      this.#db
        .prepare(
          `UPDATE conflict_resolutions SET
            run_id = NULL, state = 'failed', reason = 'not-started', detail = $detail,
            failed_starts = 1, ended_at = $at
          WHERE id = $id`,
        )
        .run({ id, detail: boundedDetail(detail), at });
    });
  }

  #selectConflictResolutions(
    where: string,
    params: Record<string, string | number>,
    now: string,
  ): ConflictResolutionRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT
          id, repository, number, url, run_id, dispatch_id,
          CASE WHEN state = 'running' AND alive_at < $live_since THEN 'failed' ELSE state END AS state,
          CASE WHEN state = 'running' AND alive_at < $live_since THEN 'interrupted' ELSE reason END AS reason,
          detail, failed_starts, started_at, alive_at, ended_at
        FROM conflict_resolutions
        ${where}
        ORDER BY id`,
      )
      .all({ ...params, live_since: liveSince(now) }) as ConflictResolutionRow[];
    return rows.map(conflictResolutionFromRow);
  }

  listConflictResolutions(now: string): ConflictResolutionRecord[] {
    return this.#selectConflictResolutions('', {}, now);
  }

  #conflictResolutionsOf(dispatchId: number, now: string): AttemptConflictResolution[] {
    return this.#selectConflictResolutions(
      'WHERE dispatch_id = $dispatch_id AND (run_id IS NULL OR EXISTS (SELECT 1 FROM runs WHERE runs.id = conflict_resolutions.run_id))',
      { dispatch_id: dispatchId },
      now,
    ).map((conflictResolution) => ({
      conflictResolution,
      run: conflictResolution.runId === null ? null : this.runs.getRun(conflictResolution.runId)!,
    }));
  }

  recordWatchedPullRequests(repository: string, watched: readonly WatchedPullRequest[]): void {
    this.#db.transaction(() => {
      this.#db
        .prepare(
          `UPDATE feedback_watches SET newest = NULL, mergeable = NULL
          WHERE repository = $repository
            AND number NOT IN (SELECT value FROM json_each($numbers))`,
        )
        .run({ repository, numbers: JSON.stringify(watched.map(({ number }) => number)) });
      const upsert = this.#db.prepare(
        `INSERT INTO feedback_watches (repository, number, url, closes, newest, mergeable, head_sha, default_sha, draft)
        VALUES ($repository, $number, $url, $closes, $newest, $mergeable, $head_sha, $default_sha, $draft)
        ON CONFLICT (repository, number) DO UPDATE SET
          url = excluded.url,
          closes = excluded.closes,
          mergeable = excluded.mergeable,
          head_sha = excluded.head_sha,
          default_sha = excluded.default_sha,
          draft = excluded.draft,
          newest = CASE
            WHEN excluded.newest IS NOT NULL
              AND (
                coalesce(held, cursor) IS NULL
                OR unixepoch(excluded.newest) > unixepoch(coalesce(held, cursor))
              )
            THEN excluded.newest
          END`,
      );
      for (const pull of watched) {
        upsert.run({
          repository,
          number: pull.number,
          url: pull.url,
          closes: JSON.stringify(pull.closes),
          newest: pull.newestFeedbackAt,
          mergeable: pull.mergeable,
          head_sha: pull.headSha,
          default_sha: pull.defaultSha,
          draft: pull.draft ? 1 : 0,
        });
      }
    });
  }

  closesByPullRequest(): Map<string, number[]> {
    const rows = this.#db.prepare(`SELECT repository, number, closes FROM feedback_watches`).all() as {
      repository: string;
      number: number;
      closes: string;
    }[];
    return new Map(rows.map((row) => [ticketKey(row.repository, row.number), JSON.parse(row.closes) as number[]]));
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
        ORDER BY repository, number`,
      )
      .all({ repositories: JSON.stringify(repositories) }) as (FeedbackWatchRow & {
      head_sha: string;
    })[];
    return rows
      .filter((row) => !this.#gradingHeldOff(row, now))
      .filter(
        (row) =>
          !this.#revisionLive(row, now) &&
          !this.#conflictResolutionLive(row, now) &&
          !this.#openingDispatchLive(row, JSON.parse(row.closes) as number[], now),
      )
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

  urgencyDue(repositories: readonly string[], now: string): UrgencyDue[] {
    const rows = this.#db
      .prepare(
        `SELECT repository, number, version FROM frontier_tickets
        WHERE forge_ready = 1
          AND version <> ''
          AND repository IN (SELECT value FROM json_each($repositories))
          AND NOT EXISTS (
            SELECT 1 FROM urgency_grades
            WHERE urgency_grades.repository = frontier_tickets.repository
              AND urgency_grades.number = frontier_tickets.number
              AND urgency_grades.version = frontier_tickets.version
          )
        ORDER BY repository, number`,
      )
      .all({ repositories: JSON.stringify(repositories) }) as unknown as UrgencyDue[];
    return rows.filter((row) => !this.#urgencyHeldOff(row, now));
  }

  #urgencyHeldOff(due: UrgencyDue, now: string): boolean {
    const latest = this.#db
      .prepare(
        `SELECT category, attempted_at,
          (SELECT count(*) FROM urgency_attempts AS every
            WHERE every.repository = latest.repository
              AND every.number = latest.number
              AND every.version = latest.version) AS failures
        FROM urgency_attempts AS latest
        WHERE repository = $repository AND number = $number AND version = $version
        ORDER BY id DESC LIMIT 1`,
      )
      .get({
        repository: due.repository,
        number: due.number,
        version: due.version,
      }) as LatestAttempt | undefined;
    return latest !== undefined && attemptHoldsOff(latest, now);
  }

  recordUrgencyAttempt(attempt: UrgencyAttempt): void {
    this.#db
      .prepare(
        `INSERT INTO urgency_attempts (
          repository, number, version, attempted_at, category, message
        ) VALUES (
          $repository, $number, $version, $attempted_at, $category, $message
        )`,
      )
      .run({
        repository: attempt.repository,
        number: attempt.number,
        version: attempt.version,
        attempted_at: attempt.attemptedAt,
        category: attempt.category,
        message: attempt.message,
      });
  }

  urgencyAttempts(repository: string, number: number): UrgencyAttempt[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM urgency_attempts
        WHERE repository = $repository AND number = $number ORDER BY id`,
      )
      .all({ repository, number }) as UrgencyAttemptRow[];
    return rows.map(urgencyAttemptFromRow);
  }

  recordUrgencyGrade(grade: UrgencyGrade): void {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO urgency_grades (
          repository, number, version, fingerprint, model, probabilities,
          score, confidence, level, uncertain, cost_usd, graded_at
        ) VALUES (
          $repository, $number, $version, $fingerprint, $model, $probabilities,
          $score, $confidence, $level, $uncertain, $cost_usd, $graded_at
        )`,
      )
      .run({
        repository: grade.repository,
        number: grade.number,
        version: grade.version,
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

  currentUrgencyGrade(repository: string, number: number): DisplayedUrgencyGrade | null {
    const row = this.#db
      .prepare(
        `SELECT urgency_grades.* FROM urgency_grades
        LEFT JOIN frontier_tickets
          ON frontier_tickets.repository = urgency_grades.repository
          AND frontier_tickets.number = urgency_grades.number
        WHERE urgency_grades.repository = $repository AND urgency_grades.number = $number
        ORDER BY urgency_grades.version = frontier_tickets.version DESC,
          urgency_grades.graded_at DESC, urgency_grades.rowid DESC LIMIT 1`,
      )
      .get({ repository, number }) as UrgencyGradeRow | undefined;
    return row === undefined ? null : urgencyGradeFromRow(row);
  }

  currentUrgencyGrades(): DisplayedUrgencyGrade[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM (
          SELECT urgency_grades.*, row_number() OVER (
            PARTITION BY urgency_grades.repository, urgency_grades.number
            ORDER BY urgency_grades.version = frontier_tickets.version DESC,
              urgency_grades.graded_at DESC, urgency_grades.rowid DESC
          ) AS rank
          FROM urgency_grades
          JOIN frontier_tickets
            ON frontier_tickets.repository = urgency_grades.repository
            AND frontier_tickets.number = urgency_grades.number
        ) WHERE rank = 1
        ORDER BY repository, number`,
      )
      .all() as UrgencyGradeRow[];
    return rows.map(urgencyGradeFromRow);
  }

  currentUrgencyAttempts(): UrgencyAttempt[] {
    const rows = this.#db
      .prepare(
        `SELECT urgency_attempts.* FROM urgency_attempts
        JOIN frontier_tickets
          ON frontier_tickets.repository = urgency_attempts.repository
          AND frontier_tickets.number = urgency_attempts.number
          AND frontier_tickets.version = urgency_attempts.version
        WHERE urgency_attempts.id = (
            SELECT max(id) FROM urgency_attempts AS later
            WHERE later.repository = urgency_attempts.repository
              AND later.number = urgency_attempts.number
              AND later.version = urgency_attempts.version
          )
          AND NOT EXISTS (
            SELECT 1 FROM urgency_grades
            WHERE urgency_grades.repository = urgency_attempts.repository
              AND urgency_grades.number = urgency_attempts.number
              AND urgency_grades.version = urgency_attempts.version
          )
        ORDER BY urgency_attempts.repository, urgency_attempts.number`,
      )
      .all() as UrgencyAttemptRow[];
    return rows.map(urgencyAttemptFromRow);
  }

  urgencyGradesAwaitingLabels(repositories: readonly string[]): DisplayedUrgencyGrade[] {
    const rows = this.#db
      .prepare(
        `SELECT urgency_grades.* FROM urgency_grades
        JOIN frontier_tickets
          ON frontier_tickets.repository = urgency_grades.repository
          AND frontier_tickets.number = urgency_grades.number
          AND frontier_tickets.version = urgency_grades.version
        WHERE urgency_grades.labels_applied = 0
          AND urgency_grades.repository IN (SELECT value FROM json_each($repositories))
        ORDER BY urgency_grades.repository, urgency_grades.number`,
      )
      .all({ repositories: JSON.stringify(repositories) }) as UrgencyGradeRow[];
    return rows.map(urgencyGradeFromRow);
  }

  markUrgencyLabelsApplied(grade: Pick<UrgencyGrade, 'repository' | 'number' | 'version'>): void {
    this.#db
      .prepare(
        `UPDATE urgency_grades SET labels_applied = (version = $version)
        WHERE repository = $repository AND number = $number`,
      )
      .run({ repository: grade.repository, number: grade.number, version: grade.version });
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

  currentRiskGrades(): RecordedRiskGrade[] {
    const rows = this.#db
      .prepare(
        `SELECT risk_grades.* FROM risk_grades
        JOIN feedback_watches USING (repository, number, head_sha)
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
        JOIN feedback_watches USING (repository, number, head_sha)
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

  workloadRunning(repository: string, number: number, now: string): boolean {
    const pullRequest = { repository, number };
    return this.#revisionLive(pullRequest, now) || this.#conflictResolutionLive(pullRequest, now);
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
        JOIN feedback_watches USING (repository, number, head_sha)
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
        JOIN feedback_watches USING (repository, number, head_sha)
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

  riskGrade(repository: string, number: number, headSha: string): RecordedRiskGrade | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM risk_grades
        WHERE repository = $repository AND number = $number AND head_sha = $head_sha`,
      )
      .get({ repository, number, head_sha: headSha }) as RiskGradeRow | undefined;
    return row === undefined ? null : riskGradeFromRow(row);
  }

  feedbackCursors(repository: string): Map<number, string | null> {
    const rows = this.#db
      .prepare(`SELECT number, cursor FROM feedback_watches WHERE repository = $repository`)
      .all({ repository }) as { number: number; cursor: string | null }[];
    return new Map(rows.map(({ number, cursor }) => [number, cursor]));
  }

  feedbackDue(now: string, quietSeconds: number): RevisedPullRequest[] {
    const rows = this.#db
      .prepare(
        `SELECT repository, number, url, closes FROM feedback_watches
        WHERE (
            newest IS NOT NULL AND unixepoch(newest) <= unixepoch($now) - $quiet
          )
          OR (
            mergeable IS NOT NULL
            AND (
              SELECT latest.reason FROM revisions latest
              WHERE latest.repository = feedback_watches.repository
                AND latest.number = feedback_watches.number
              ORDER BY latest.id DESC LIMIT 1
            ) = 'not-started'
          )
        ORDER BY unixepoch(newest), repository, number`,
      )
      .all({ now, quiet: quietSeconds }) as FeedbackWatchRow[];
    return rows
      .filter((row) => {
        return (
          !this.#revisionLive(row, now) &&
          !this.#conflictResolutionLive(row, now) &&
          !this.#openingDispatchLive(row, JSON.parse(row.closes) as number[], now)
        );
      })
      .map(({ repository, number, url }) => ({ repository, number, url }));
  }

  conflictsDue(now: string): RevisedPullRequest[] {
    const rows = this.#db
      .prepare(
        `SELECT repository, number, url, closes FROM feedback_watches
        WHERE mergeable = 'CONFLICTING'
          AND head_sha IS NOT NULL
          AND default_sha IS NOT NULL
          AND (
            NOT EXISTS (
              SELECT 1 FROM conflict_resolutions
              WHERE conflict_resolutions.repository = feedback_watches.repository
                AND conflict_resolutions.number = feedback_watches.number
                AND conflict_resolutions.head_sha = feedback_watches.head_sha
                AND conflict_resolutions.default_sha = feedback_watches.default_sha
            )
            OR (
              SELECT latest.reason FROM conflict_resolutions latest
              WHERE latest.repository = feedback_watches.repository
                AND latest.number = feedback_watches.number
              ORDER BY latest.id DESC LIMIT 1
            ) = 'not-started'
          )
        ORDER BY repository, number`,
      )
      .all() as FeedbackWatchRow[];
    return rows
      .filter(
        (row) =>
          !this.#revisionLive(row, now) &&
          !this.#conflictResolutionLive(row, now) &&
          !this.#openingDispatchLive(row, JSON.parse(row.closes) as number[], now),
      )
      .map(({ repository, number, url }) => ({ repository, number, url }));
  }

  recordRevisionStartFailure(pullRequest: RevisedPullRequest, detail: string, at: string): void {
    this.#db.transaction(() => {
      if (this.#revisionLive(pullRequest, at)) return;
      const latest = this.#latestRevision(pullRequest);
      if (latest?.reason === 'not-started') {
        this.#db
          .prepare(
            `UPDATE revisions SET
              detail = $detail, failed_starts = COALESCE(failed_starts, 0) + 1,
              started_at = $at, alive_at = $at, ended_at = $at
            WHERE id = $id`,
          )
          .run({ id: latest.id, detail: boundedDetail(detail), at });
        return;
      }
      this.#db
        .prepare(
          `INSERT INTO revisions (
            repository, number, url, run_id, dispatch_id, state, reason, detail, failed_starts,
            started_at, alive_at, ended_at, feedback_cursor
          ) VALUES (
            $repository, $number, $url, NULL, $dispatch_id, 'failed', 'not-started', $detail, 1,
            $at, $at, $at, $cursor
          )`,
        )
        .run({
          repository: pullRequest.repository,
          number: pullRequest.number,
          url: pullRequest.url,
          dispatch_id: this.#openingDispatchId(pullRequest),
          detail: boundedDetail(detail),
          at,
          cursor: this.#feedbackCursor(pullRequest),
        });
    });
  }

  failRevisionStart(id: number, detail: string, at: string): void {
    this.#db.transaction(() => {
      const row = this.#db.prepare(`SELECT * FROM revisions WHERE id = $id`).get({ id }) as
        | RevisionRow
        | undefined;
      if (row === undefined) return;
      const previous = this.#db
        .prepare(
          `SELECT id, reason FROM revisions
          WHERE repository = $repository AND number = $number AND id < $id
          ORDER BY id DESC LIMIT 1`,
        )
        .get({ repository: row.repository, number: row.number, id }) as
        | { id: number; reason: string | null }
        | undefined;
      if (row.state === 'running') this.#giveFeedbackBack(id);
      if (previous?.reason === 'not-started') {
        this.#db
          .prepare(
            `UPDATE revisions SET
              detail = $detail, failed_starts = COALESCE(failed_starts, 0) + 1,
              started_at = $at, alive_at = $at, ended_at = $at
            WHERE id = $id`,
          )
          .run({ id: previous.id, detail: boundedDetail(detail), at });
        this.#db.prepare(`DELETE FROM revisions WHERE id = $id`).run({ id });
        return;
      }
      this.#db
        .prepare(
          `UPDATE revisions SET
            run_id = NULL, state = 'failed', reason = 'not-started', detail = $detail,
            failed_starts = 1, ended_at = $at
          WHERE id = $id`,
        )
        .run({ id, detail: boundedDetail(detail), at });
    });
  }

  recordRevisionPush(id: number, headSha: string): void {
    this.#db.prepare(`UPDATE revisions SET pushed_sha = $head_sha WHERE id = $id`).run({ id, head_sha: headSha });
  }

  touchRevision(id: number, now: string): void {
    this.#db
      .prepare(`UPDATE revisions SET alive_at = $now WHERE id = $id AND state = 'running'`)
      .run({ id, now });
  }

  endRevision(
    id: number,
    state: Exclude<RevisionState, 'running'>,
    endedAt: string,
    failure?: RevisionFailureRecord,
  ): void {
    this.#db.transaction(() => {
      const before = this.#db.prepare(`SELECT state FROM revisions WHERE id = $id`).get({ id }) as
        | { state: string }
        | undefined;
      this.#db
        .prepare(
          `UPDATE revisions SET
            state = $state, reason = $reason, detail = $detail, ended_at = $ended_at
          WHERE id = $id`,
        )
        .run({
          id,
          state,
          reason: failure?.reason ?? null,
          detail: boundedDetail(failure?.detail ?? null),
          ended_at: endedAt,
        });
      if (state === 'failed' && before?.state === 'running') this.#giveFeedbackBack(id);
    });
  }

  #selectRevisions(where: string, params: Record<string, string | number>, now: string): RevisionRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT
          id, repository, number, url, run_id, dispatch_id,
          CASE WHEN state = 'running' AND alive_at < $live_since THEN 'failed' ELSE state END AS state,
          CASE WHEN state = 'running' AND alive_at < $live_since THEN 'interrupted' ELSE reason END AS reason,
          detail, failed_starts, started_at, alive_at, ended_at
        FROM revisions
        ${where}
        ORDER BY id`,
      )
      .all({ ...params, live_since: liveSince(now) }) as RevisionRow[];
    return rows.map(revisionFromRow);
  }

  #revisionsOf(dispatchId: number, now: string): AttemptRevision[] {
    return this.#selectRevisions(
      'WHERE dispatch_id = $dispatch_id AND (run_id IS NULL OR EXISTS (SELECT 1 FROM runs WHERE runs.id = revisions.run_id))',
      { dispatch_id: dispatchId },
      now,
    ).map((revision) => ({
      revision,
      run: revision.runId === null ? null : this.runs.getRun(revision.runId)!,
    }));
  }

  pullRequestWorkloadOfRun(runId: string, now: string): RunPullRequestWorkload | null {
    const revision = this.#selectRevisions('WHERE run_id = $run_id', { run_id: runId }, now)[0];
    if (revision !== undefined) return { kind: 'revision', workload: revision };
    const resolution = this.#selectConflictResolutions('WHERE run_id = $run_id', { run_id: runId }, now)[0];
    return resolution === undefined ? null : { kind: 'conflict-resolution', workload: resolution };
  }

  listRevisions(now: string): RevisionRecord[] {
    return this.#selectRevisions('', {}, now);
  }

  reconcileDispatch(
    ticket: DispatchTicket,
    now: string,
  ): Exclude<DispatchState, 'running'> | null {
    let settled: Exclude<DispatchState, 'running'> | null = null;
    this.#db.transaction(() => {
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

  #selectDispatches(where: string, params: Record<string, string>, now: string): DispatchRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT
          d.id, d.repository, d.number, d.url,
          CASE WHEN EXISTS (SELECT 1 FROM runs WHERE id = d.run_id) THEN d.run_id END AS run_id,
          CASE WHEN d.state = 'running' AND d.alive_at < $live_since THEN 'failed' ELSE d.state END AS state,
          CASE WHEN d.state = 'running' AND d.alive_at < $live_since THEN 'interrupted' ELSE d.reason END AS reason,
          d.detail, d.failed_starts, d.started_at, d.alive_at, d.ended_at,
          d.pr_number, d.pr_url, d.pr_state, d.pr_settled_at, d.pr_rework
        FROM dispatches d
        ${where}
        ORDER BY d.repository, d.number, d.id`,
      )
      .all({ ...params, live_since: liveSince(now) }) as DispatchRow[];
    return rows.map(dispatchFromRow);
  }

  listDispatches(now: string): DispatchRecord[] {
    return this.#selectDispatches(
      `WHERE d.id = (
          SELECT MAX(id) FROM dispatches
          WHERE repository = d.repository AND number = d.number
        )`,
      {},
      now,
    );
  }

  listRunDispatches(now: string): DispatchRecord[] {
    return this.#selectDispatches('WHERE EXISTS (SELECT 1 FROM runs WHERE id = d.run_id)', {}, now);
  }

  mapRunDispatches(now: string): Map<string, DispatchRecord> {
    const byRun = new Map<string, DispatchRecord>();
    for (const dispatch of this.listRunDispatches(now)) byRun.set(dispatch.runId!, dispatch);
    return byRun;
  }

  dispatchOfRun(runId: string, now: string): DispatchRecord | null {
    return this.#selectDispatches('WHERE d.run_id = $run_id', { run_id: runId }, now).at(-1) ?? null;
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
