import type { Hono } from 'hono';
import {
  attemptOutcome,
  BOX_API_PREFIX,
  diagnosisView,
  REPOSITORIES_ROUTE,
  ticketPath,
  type AttemptView,
  type PullRequestWorkloadRecord,
  type RepositoriesView,
  type RunningPullRequestWorkload,
  type RunningView,
  type RunningWorkload,
  type Store,
  type TicketView,
} from '@forge/shared';

const TICKET_NUMBER = /^[1-9]\d*$/;

const READ_METHODS = 'GET, HEAD';

const runPath = (runId: string): string => `/runs/${encodeURIComponent(runId)}`;

export const ticketView = (store: Store, ticket: { repository: string; number: number }, now: string): TicketView => {
  const records = store.workloads.listAttempts(ticket, now);
  const attempts = records.map((attempt): AttemptView => {
    const dispatch = store.workloads.dispatchOfRun(attempt.run.id, now);
    const diagnosis = store.diagnoses.diagnosesOf(attempt.run.id, now)[0];
    return {
      runId: attempt.run.id,
      startedAt: attempt.run.startTime,
      endedAt: attempt.run.endTime,
      outcome: attemptOutcome(attempt),
      failureReason: dispatch?.reason ?? null,
      failureDetail: dispatch?.detail ?? null,
      pullRequest: attempt.pullRequest === null ? null : { number: attempt.pullRequest.number, url: attempt.pullRequest.url, state: attempt.pullRequest.state },
      diagnosis: diagnosis === undefined ? null : diagnosisView(diagnosis),
      dashboard: runPath(attempt.run.id),
    };
  });
  const latest = attempts[0];
  return {
    repository: ticket.repository,
    number: ticket.number,
    url: records[0]?.run.ticket?.url ?? null,
    dashboard: ticketPath(ticket.repository, ticket.number),
    outcome: latest?.outcome ?? null,
    failureReason: latest?.failureReason ?? null,
    failureDetail: latest?.failureDetail ?? null,
    pullRequest: latest?.pullRequest ?? null,
    diagnosis: latest?.diagnosis ?? null,
    attempts,
  };
};

const runningSince = (startedAt: string, now: string, runId: string | null): RunningWorkload => ({
  runId,
  startedAt,
  runningSeconds: Math.max(0, Math.floor((Date.parse(now) - Date.parse(startedAt)) / 1000)),
  dashboard: runId === null ? null : runPath(runId),
});

export const runningView = (store: Store, now: string): RunningView => {
  const pullRequestWorkloads = (records: PullRequestWorkloadRecord[]): RunningPullRequestWorkload[] =>
    records
      .filter(({ state }) => state === 'running')
      .map(({ repository, number, url, startedAt, runId }) => ({ pullRequest: { repository, number, url }, ...runningSince(startedAt, now, runId) }));
  return {
    dispatches: store.workloads
      .listDispatches(now)
      .filter(({ state }) => state === 'running')
      .map(({ repository, number, url, startedAt, runId }) => ({ ticket: { repository, number, url }, ...runningSince(startedAt, now, runId) })),
    revisions: pullRequestWorkloads(store.workloads.listRevisions(now)),
    conflictResolutions: pullRequestWorkloads(store.workloads.listConflictResolutions(now)),
  };
};

export const mountApi = (app: Hono, store: Store, clock: () => Date, repositories: RepositoriesView): void => {
  app.get(`${BOX_API_PREFIX}/tickets/:repository/:number`, (c) => {
    const raw = c.req.param('number');
    const number = Number(raw);
    if (!TICKET_NUMBER.test(raw) || !Number.isSafeInteger(number)) return c.notFound();
    return c.json(ticketView(store, { repository: c.req.param('repository'), number }, clock().toISOString()));
  });

  app.get(`${BOX_API_PREFIX}/running`, (c) => c.json(runningView(store, clock().toISOString())));

  app.get(REPOSITORIES_ROUTE, (c) => c.json(repositories));

  app.all(`${BOX_API_PREFIX}/*`, (c) =>
    c.req.method === 'GET' || c.req.method === 'HEAD'
      ? c.notFound()
      : c.json({ error: 'the JSON interface is read-only' }, 405, { Allow: READ_METHODS }),
  );
};
