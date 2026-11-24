import type { SQLInputValue } from 'node:sqlite';
import { openConnection, type Connection } from './connection.ts';
import { Grades } from './grades.ts';
import { migrate } from './migrate.ts';
import { CURRENT_HEAD_OF_WATCH, liveConflictResolutionOn, liveOpeningDispatchOf, liveRevisionOn, Workloads } from './workloads.ts';
import { AutoMerge } from './auto-merge.ts';
import { Diagnoses } from './diagnoses.ts';
import {
  attemptHoldsOff,
  RETRIED_GRADING_FAILURES,
  type GradingFailure,
  type LatestAttempt,
} from './grading-policy.ts';
import { Insights } from './insights.ts';
import { Runs } from './runs.ts';
import { Urgency } from './urgency.ts';
import { newestClosedFirst, oldestFirst, type ClosedTicket, type PolledFrontier, type PollFailure, type RepositoryProblems, type RefinementRequest, type RepositoryFrontier, type Ticket } from '../frontier.ts';
import { type PullRequestState } from '../dispatch.ts';
import type { RiskFilter } from '../risk.ts';

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
  readonly grades: Grades;
  readonly workloads: Workloads;
  readonly runs: Runs;
  readonly diagnoses: Diagnoses;
  readonly autoMerge: AutoMerge;
  readonly urgency: Urgency;
  readonly insights: Insights;

  private constructor(db: Connection) {
    this.#db = db;
    this.runs = new Runs(db);
    this.diagnoses = new Diagnoses(db);
    this.workloads = new Workloads(db, {
      getRun: (id) => this.runs.getRun(id),
      getFingerprint: (id) => this.runs.getFingerprint(id),
    });
    this.autoMerge = new AutoMerge(db);
    this.grades = new Grades(db, (pullRequest, closes, now) => this.workloads.pullRequestLive(pullRequest, closes, now));
    this.urgency = new Urgency(db);
    this.insights = new Insights(db);
  }

  static open(path: string): Store {
    const connection = openConnection(path);
    migrate(connection);
    return new Store(connection);
  }

  static openReadOnly(path: string): Store {
    return new Store(openConnection(path, { readOnly: true }));
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

  read<Row>(sql: string, parameters: Record<string, SQLInputValue> = {}): Row[] {
    return this.#db.prepare(sql).all(parameters) as Row[];
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
