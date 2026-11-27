import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FrontierTicketView, RepositoryFrontierView, RepositoryView, RunningView, TicketView } from '@forge/shared';
import { createOperations, FakeBox, FakeGitHub } from '../src/index.ts';

const FAILED: TicketView = {
  repository: 'forge',
  number: 7,
  url: 'https://github.com/rameezk/forge/issues/7',
  dashboard: '/tickets/forge/7',
  outcome: 'failed',
  failureReason: 'check-failed',
  failureDetail: 'build broke',
  pullRequest: null,
  diagnosis: {
    state: 'done',
    category: 'skill',
    evidence: [{ turn: 4, note: 'the worker skipped the skill' }],
    suggestedFix: 'Name the file to edit in the skill',
    detail: null,
  },
  attempts: [
    {
      runId: 'run-1',
      startedAt: '2026-11-01T10:00:00.000Z',
      endedAt: '2026-11-01T10:03:20.000Z',
      outcome: 'failed',
      failureReason: 'check-failed',
      failureDetail: 'build broke',
      pullRequest: null,
      diagnosis: null,
      dashboard: '/runs/run-1',
    },
  ],
};

const operationsOver = (box: FakeBox) => createOperations({ box, github: new FakeGitHub() });

test('given a fake box holding a ticket whose latest attempt failed with a diagnosis, when ticket is called for it, then the result carries the outcome, the failure reason, the diagnosis and the dashboard links', async () => {
  const operations = operationsOver(new FakeBox({ tickets: [FAILED] }));

  const ticket = await operations.ticket({ repository: 'forge', number: 7 });

  assert.equal(ticket.outcome, 'failed');
  assert.equal(ticket.failureReason, 'check-failed');
  assert.equal(ticket.failureDetail, 'build broke');
  assert.equal(ticket.diagnosis?.category, 'skill');
  assert.equal(ticket.diagnosis?.suggestedFix, 'Name the file to edit in the skill');
  assert.equal(ticket.dashboard, 'http://box.test/tickets/forge/7');
  assert.equal(ticket.attempts[0]?.dashboard, 'http://box.test/runs/run-1');
});

test('given a fake box that holds nothing for a ticket, when ticket is called for it, then it reports no attempts', async () => {
  const ticket = await operationsOver(new FakeBox()).ticket({ repository: 'forge', number: 9 });
  assert.deepEqual(ticket.attempts, []);
  assert.equal(ticket.outcome, null);
  assert.equal(ticket.dashboard, 'http://box.test/tickets/forge/9');
});

test('given a fake box running a dispatch, a revision and a conflict resolution, when running is called, then each is listed with its ticket or pull request, how long it has run and its dashboard link', async () => {
  const running: RunningView = {
    dispatches: [{ ticket: { repository: 'forge', number: 7, url: 'https://github.com/rameezk/forge/issues/7' }, runId: 'run-2', startedAt: '2026-11-01T10:58:30.000Z', runningSeconds: 90, dashboard: '/runs/run-2' }],
    revisions: [{ pullRequest: { repository: 'forge', number: 12, url: 'https://github.com/rameezk/forge/pull/12' }, runId: 'run-3', startedAt: '2026-11-01T10:59:00.000Z', runningSeconds: 60, dashboard: '/runs/run-3' }],
    conflictResolutions: [{ pullRequest: { repository: 'forge', number: 13, url: 'https://github.com/rameezk/forge/pull/13' }, runId: null, startedAt: '2026-11-01T10:59:30.000Z', runningSeconds: 30, dashboard: null }],
  };

  const result = await operationsOver(new FakeBox({ running })).running();

  assert.equal(result.dispatches[0]?.ticket.number, 7);
  assert.equal(result.dispatches[0]?.runningSeconds, 90);
  assert.equal(result.dispatches[0]?.dashboard, 'http://box.test/runs/run-2');
  assert.equal(result.revisions[0]?.pullRequest.number, 12);
  assert.equal(result.revisions[0]?.runningSeconds, 60);
  assert.equal(result.conflictResolutions[0]?.pullRequest.number, 13);
  assert.equal(result.conflictResolutions[0]?.dashboard, null);
});

const issue = (number: number, overrides: Partial<FrontierTicketView> = {}): FrontierTicketView => ({
  number,
  title: `Ticket ${number}`,
  url: `https://github.com/rameezk/forge/issues/${number}`,
  readyFor: 'agent',
  blockedBy: [],
  assignees: [],
  ...overrides,
});

const FORGE: RepositoryFrontierView = {
  repository: 'forge',
  github: 'rameezk/forge',
  frontier: [issue(1)],
  queued: [issue(2)],
  assigned: [issue(3, { assignees: [{ login: 'octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4' }] })],
};

const OTHER: RepositoryFrontierView = { repository: 'other', github: 'rameezk/other', frontier: [issue(9)], queued: [], assigned: [] };

test('given a fake box holding a repository with a frontier ticket, a queued ticket and an assigned ticket, when frontier is called for it, then all three are returned and the assigned one carries its assignee', async () => {
  const { repositories } = await operationsOver(new FakeBox({ frontier: [FORGE] })).frontier({});

  assert.equal(repositories.length, 1);
  assert.deepEqual(repositories[0]?.frontier.map(({ number }) => number), [1]);
  assert.deepEqual(repositories[0]?.queued.map(({ number }) => number), [2]);
  assert.deepEqual(repositories[0]?.assigned.map(({ number, assignees }) => [number, assignees.map(({ login }) => login)]), [[3, ['octocat']]]);
});

test('given a fake box holding two managed repositories, when frontier is called naming one of them, then only that repository is returned', async () => {
  const { repositories } = await operationsOver(new FakeBox({ frontier: [FORGE, OTHER] })).frontier({ repository: 'other' });

  assert.deepEqual(repositories.map(({ repository }) => repository), ['other']);
});

test('given a fake box holding two managed repositories, when frontier is called without a repository, then both are returned', async () => {
  const { repositories } = await operationsOver(new FakeBox({ frontier: [FORGE, OTHER] })).frontier({});

  assert.deepEqual(repositories.map(({ repository }) => repository), ['forge', 'other']);
});

test('given a fake box that does not manage a repository, when frontier is called naming it, then it fails naming the repository', async () => {
  await assert.rejects(operationsOver(new FakeBox({ frontier: [FORGE] })).frontier({ repository: 'ghost' }), /ghost/);
});

const HEALTHY: RepositoryView = { repository: 'forge', github: 'rameezk/forge', polling: true, polledAt: '2026-11-01T10:59:00.000Z', lastError: null, rulesPass: true, ruleFailures: [] };
const BROKEN: RepositoryView = { repository: 'broken', github: 'rameezk/broken', polling: false, polledAt: null, lastError: { message: 'GitHub answered 502', failedAt: '2026-11-01T10:59:00.000Z' }, rulesPass: null, ruleFailures: [] };

test('given one repository whose last poll failed and one whose default branch rules pass, when repository is called for each, then the first reports the failed poll and the second reports it is polling with passing rules', async () => {
  const operations = operationsOver(new FakeBox({ repositories: [HEALTHY, BROKEN] }));

  const broken = await operations.repository({ repository: 'broken' });
  assert.equal(broken.polling, false);
  assert.equal(broken.lastError?.message, 'GitHub answered 502');

  const healthy = await operations.repository({ repository: 'forge' });
  assert.equal(healthy.polling, true);
  assert.equal(healthy.rulesPass, true);
});

test('given a fake box that does not manage a repository, when repository is called for it, then it fails naming the repository', async () => {
  await assert.rejects(operationsOver(new FakeBox()).repository({ repository: 'ghost' }), /ghost/);
});
