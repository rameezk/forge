import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunningView, TicketView } from '@forge/shared';
import { createOperations, FakeBox } from '../src/index.ts';

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

const operationsOver = (box: FakeBox) => createOperations({ box });

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
