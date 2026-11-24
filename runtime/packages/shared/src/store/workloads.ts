import type { Connection } from './connection.ts';
import { migrateWorkloads } from './migrations/workloads.ts';
import { DISPATCH_DETAIL_LIMIT, ticketKey, type DispatchFailure, type DispatchOutcome, type DispatchRecord, type DispatchStart, type DispatchState, type DispatchTicket, type PullRequestRecord, type PullRequestState } from '../dispatch.ts';
import type { ConflictResolutionFailure, ConflictResolutionFailureRecord, ConflictResolutionRecord, ConflictResolutionStart, ConflictResolutionState, RunPullRequestWorkload, ShaPair } from '../conflict-resolution.ts';
import type { RevisedPullRequest, RevisionFailure, RevisionFailureRecord, RevisionRecord, RevisionStart, RevisionState } from '../revision.ts';
import type { WatchedPullRequest } from '../feedback.ts';
import type { AttemptConflictResolution, AttemptRevision, TicketAttempt } from '../attempts.ts';
import type { RunFingerprint } from '../fingerprint.ts';
import { STALE_AFTER_MS } from '../heartbeat.ts';
import type { RunRecord } from '../run.ts';


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

export const boundedDetail = (detail: string | null): string | null =>
  detail === null || detail.length <= DISPATCH_DETAIL_LIMIT
    ? detail
    : `${detail.slice(0, DISPATCH_DETAIL_LIMIT - 1)}…`;

export const liveSince = (now: string): string =>
  new Date(Date.parse(now) - STALE_AFTER_MS).toISOString();

export const CURRENT_HEAD_OF_WATCH = `JOIN feedback_watches USING (repository, number, head_sha)`;

const latestIsLive = (table: string, subject: string): string => `EXISTS (
  SELECT 1 FROM ${table}
  WHERE ${table}.repository = ${subject}.repository
    AND ${table}.number = ${subject}.number
    AND ${table}.id = (
      SELECT max(id) FROM ${table} AS later
      WHERE later.repository = ${subject}.repository AND later.number = ${subject}.number
    )
    AND ${table}.state = 'running'
    AND ${table}.alive_at >= $live_since
)`;

export const liveRevisionOn = (subject: string): string => latestIsLive('revisions', subject);

export const liveConflictResolutionOn = (subject: string): string =>
  latestIsLive('conflict_resolutions', subject);

export const liveOpeningDispatchOf = (subject: string): string => `EXISTS (
  SELECT 1 FROM json_each(${subject}.closes) AS opening
  JOIN dispatches ON dispatches.repository = ${subject}.repository AND dispatches.number = opening.value
  WHERE dispatches.id = (
      SELECT max(id) FROM dispatches AS later
      WHERE later.repository = dispatches.repository AND later.number = dispatches.number
    )
    AND dispatches.state = 'running'
    AND dispatches.alive_at >= $live_since
)`;

export interface RunLookup {
  getRun(id: string): RunRecord | undefined;
  getFingerprint(id: string): RunFingerprint | null;
}

export class Workloads {
  readonly #db: Connection;
  readonly #runs: RunLookup;

  constructor(db: Connection, runs: RunLookup) {
    this.#db = db;
    this.#runs = runs;
  }

  static migrate(db: Connection): void {
    migrateWorkloads(db);
  }

  pruneWatches(declared: readonly string[]): void {
    this.#db
      .prepare(
        `DELETE FROM feedback_watches
        WHERE repository NOT IN (SELECT value FROM json_each($declared))`,
      )
      .run({ declared: JSON.stringify(declared) });
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
      run: this.#runs.getRun(run_id)!,
      config: this.#runs.getFingerprint(run_id),
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
      run: conflictResolution.runId === null ? null : this.#runs.getRun(conflictResolution.runId)!,
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
      run: revision.runId === null ? null : this.#runs.getRun(revision.runId)!,
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
}
