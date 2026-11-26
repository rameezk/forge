import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RepositoryView, RunningView } from '@forge/shared';
import { createOperations, FakeBox, FakeGitHub, type FakeIssue } from '../src/index.ts';

const FORGE: RepositoryView = { name: 'forge', github: 'rameezk/forge', ticketPrompt: '/work-on {url}' };
const NOTES: RepositoryView = { name: 'notes', github: 'rameezk/notes', ticketPrompt: null };

const READY: FakeIssue = { github: 'rameezk/forge', number: 7, open: true, labels: ['ready-for-agent'], assignees: [], blockedBy: [] };

const setup = ({ issues = [READY], running }: { issues?: FakeIssue[]; running?: RunningView } = {}) => {
  const github = new FakeGitHub({ operator: 'operator', issues });
  const box = new FakeBox({ repositories: [FORGE, NOTES], ...(running === undefined ? {} : { running }) });
  return { github, operations: createOperations({ box, github }) };
};

test('given an unassigned, unblocked ready-for-agent ticket, when dispatch is called, then GitHub receives forge:ready on that ticket and nothing else is written', async () => {
  const { github, operations } = setup();

  const result = await operations.dispatch({ repository: 'forge', number: 7 });

  assert.equal(result.dispatched, true);
  assert.deepEqual(github.writes, [{ kind: 'label', github: 'rameezk/forge', number: 7, label: 'forge:ready' }]);
});

test('given an unassigned ready-for-agent ticket with an open blocker, when dispatch is called, then forge:ready is applied and the result says the ticket is queued behind its blocker', async () => {
  const { github, operations } = setup({ issues: [{ ...READY, blockedBy: [3] }] });

  const result = await operations.dispatch({ repository: 'forge', number: 7 });

  assert.ok(result.dispatched);
  assert.equal(result.queued, true);
  assert.match(result.message, /queued behind #3/);
  assert.equal(github.writes.length, 1);
});

test('given a ready-for-human ticket, when dispatch is called, then it is refused with its reason and GitHub receives no write', async () => {
  const { github, operations } = setup({ issues: [{ ...READY, labels: ['ready-for-human'] }] });

  const result = await operations.dispatch({ repository: 'forge', number: 7 });

  assert.ok(!result.dispatched);
  assert.match(result.reason, /not labelled ready-for-agent/);
  assert.deepEqual(github.writes, []);
});

test('given a ready-for-agent ticket assigned to someone, when dispatch is called, then it is refused naming the assignee and GitHub receives no write', async () => {
  const { github, operations } = setup({ issues: [{ ...READY, assignees: ['alice', 'bob'] }] });

  const result = await operations.dispatch({ repository: 'forge', number: 7 });

  assert.ok(!result.dispatched);
  assert.match(result.reason, /assigned to alice, bob/);
  assert.match(result.reason, /Release it first/);
  assert.deepEqual(github.writes, []);
});

test('given a closed ticket, when dispatch is called, then it is refused and GitHub receives no write', async () => {
  const { github, operations } = setup({ issues: [{ ...READY, open: false }] });

  const result = await operations.dispatch({ repository: 'forge', number: 7 });

  assert.ok(!result.dispatched);
  assert.match(result.reason, /closed/);
  assert.deepEqual(github.writes, []);
});

test('given a repository forge does not manage, when dispatch is called, then it fails naming the repository and GitHub receives no write', async () => {
  const { github, operations } = setup();

  await assert.rejects(operations.dispatch({ repository: 'elsewhere', number: 7 }), /elsewhere/);
  assert.deepEqual(github.writes, []);
});

test('given a ticket already assigned to someone else, when claim is called, then the operator is assigned and the result warns who else holds it', async () => {
  const { github, operations } = setup({ issues: [{ ...READY, assignees: ['alice'] }] });

  const result = await operations.claim({ repository: 'forge', number: 7 });

  assert.equal(github.writes.length, 1);
  assert.match(result.warning ?? '', /already assigned to alice/);
});

test('given each write, when it succeeds, then the result names the GitHub repository it wrote to', async () => {
  const { operations } = setup({ issues: [{ ...READY }, { ...READY, number: 8, assignees: ['operator'] }] });

  const dispatched = await operations.dispatch({ repository: 'forge', number: 7 });
  const claimed = await operations.claim({ repository: 'forge', number: 7 });
  const released = await operations.release({ repository: 'forge', number: 8 });

  assert.ok(dispatched.dispatched && released.released);
  assert.deepEqual([dispatched.github, claimed.github, released.github], ['rameezk/forge', 'rameezk/forge', 'rameezk/forge']);
});

test('given a ticket in a repository whose on.ticket worker prompt is /work-on {url}, when claim is called, then the operator is assigned and the result carries /work-on followed by the ticket URL', async () => {
  const { github, operations } = setup();

  const result = await operations.claim({ repository: 'forge', number: 7 });

  assert.deepEqual(github.writes, [{ kind: 'assign', github: 'rameezk/forge', number: 7, login: 'operator' }]);
  assert.equal(result.claimed, true);
  assert.equal(result.assignee, 'operator');
  assert.equal(result.prompt?.text, '/work-on https://github.com/rameezk/forge/issues/7');
  assert.match(result.prompt?.description ?? '', /How forge works tickets in forge/);
  assert.equal(result.warning, null);
});

test('given a prompt using {repo}, {issue} and {url}, when claim is called, then each is filled in', async () => {
  const forge = { ...FORGE, ticketPrompt: 'Work {repo}#{issue} ({url}) in {repo}' };
  const github = new FakeGitHub({ operator: 'operator', issues: [READY] });
  const operations = createOperations({ box: new FakeBox({ repositories: [forge] }), github });

  const result = await operations.claim({ repository: 'forge', number: 7 });

  assert.equal(result.prompt?.text, 'Work rameezk/forge#7 (https://github.com/rameezk/forge/issues/7) in rameezk/forge');
});

test('given a ticket with a live dispatch, when claim is called, then the operator is assigned and the result warns that a workload is running on it', async () => {
  const running: RunningView = {
    dispatches: [{ ticket: { repository: 'forge', number: 7, url: 'https://github.com/rameezk/forge/issues/7' }, runId: 'run-2', startedAt: '2026-11-01T10:58:30.000Z', runningSeconds: 90, dashboard: '/runs/run-2' }],
    revisions: [],
    conflictResolutions: [],
  };
  const { github, operations } = setup({ running });

  const result = await operations.claim({ repository: 'forge', number: 7 });

  assert.equal(github.writes.length, 1);
  assert.match(result.warning ?? '', /workload is running on rameezk\/forge#7/);
});

test('given a repository with no on.ticket worker, when claim is called on one of its tickets, then the operator is assigned and no prompt is returned', async () => {
  const { github, operations } = setup({ issues: [{ ...READY, github: 'rameezk/notes' }] });

  const result = await operations.claim({ repository: 'notes', number: 7 });

  assert.deepEqual(github.writes, [{ kind: 'assign', github: 'rameezk/notes', number: 7, login: 'operator' }]);
  assert.equal(result.prompt, null);
});

test('given a ticket assigned to the operator, when release is called, then the operator is unassigned and nothing else is written', async () => {
  const { github, operations } = setup({ issues: [{ ...READY, assignees: ['operator', 'alice'] }] });

  const result = await operations.release({ repository: 'forge', number: 7 });

  assert.equal(result.released, true);
  assert.deepEqual(github.writes, [{ kind: 'unassign', github: 'rameezk/forge', number: 7, login: 'operator' }]);
});

test('given a ticket not assigned to the operator, when release is called, then it says so and nothing is written', async () => {
  const { github, operations } = setup({ issues: [{ ...READY, assignees: ['alice'] }] });

  const result = await operations.release({ repository: 'forge', number: 7 });

  assert.equal(result.released, false);
  assert.deepEqual(github.writes, []);
});
