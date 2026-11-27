import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import type { FrontierView, ManagedRepositoryView, RepositoryView, RunRecord, RunningView, Ticket, TicketView } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';

const ISSUE = 'https://github.com/rameezk/forge/issues/7';
const TICKET = { repository: 'forge', number: 7, url: ISSUE };
const PULL = { repository: 'forge', number: 12, url: 'https://github.com/rameezk/forge/pull/12' };
const NOW = '2026-11-01T11:00:00.000Z';

const aRun = (id: string, worker: string, overrides: Partial<RunRecord> = {}): RunRecord => ({
  id,
  worker,
  harness: 'pi',
  model: 'z-ai/glm-5',
  reasoningEffort: null,
  startTime: '2026-11-01T10:00:00.000Z',
  endTime: '2026-11-01T10:03:20.000Z',
  status: 'success',
  costStatus: 'billed',
  costUsd: 0.12,
  costEstimated: false,
  unconfirmedEstimateUsd: 0,
  listPrice: null,
  inputTokens: 10,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  transcriptRef: 'secret-transcript',
  sessionId: null,
  error: null,
  ticket: TICKET,
  aliveAt: null,
  harnessStartTime: null,
  timeoutSeconds: null,
  maxCostUsd: null,
  exceededLimit: null,
  counters: null,
  ...overrides,
});

const seedFailure = (store: Store): void => {
  store.runs.insertRun(aRun('failed', 'builder'));
  const dispatch = store.workloads.startDispatch(TICKET, 'failed', '2026-11-01T10:00:00.000Z', 10, null);
  assert.ok('started' in dispatch);
  store.workloads.endDispatch(dispatch.started, { state: 'failed', reason: 'check-failed', detail: 'build broke' }, '2026-11-01T10:03:20.000Z');
  store.runs.insertRun(aRun('diagnosis', 'diagnoser'));
  const id = store.diagnoses.startDiagnosis('failed', 'diagnosis', NOW);
  store.diagnoses.endDiagnosis(id, 'done', NOW, {
    verdict: { category: 'skill', evidence: [{ turn: 4, note: 'the worker skipped the skill' }], suggestedFix: 'Name the file to edit in the skill' },
  });
};

const appOver = (store: Store, clock = () => new Date(NOW), repositories: ManagedRepositoryView[] = []) =>
  createApp({ store, transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))), css: '', logo: '', idiomorph: '', client: '', clock, repositories });

test('given a ticket with a failed attempt and its diagnosis, when its JSON route is requested, then the response holds its attempts, the outcome with its failure reason, the diagnosis and dashboard links, and no transcript', async () => {
  const store = Store.open(':memory:');
  seedFailure(store);

  const res = await appOver(store).request('/api/tickets/forge/7');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  const text = await res.text();
  const ticket = JSON.parse(text) as TicketView;

  assert.equal(ticket.repository, 'forge');
  assert.equal(ticket.number, 7);
  assert.equal(ticket.url, ISSUE);
  assert.equal(ticket.dashboard, '/tickets/forge/7');
  assert.equal(ticket.outcome, 'failed');
  assert.equal(ticket.failureReason, 'check-failed');
  assert.equal(ticket.failureDetail, 'build broke');
  assert.equal(ticket.diagnosis?.category, 'skill');
  assert.equal(ticket.diagnosis?.suggestedFix, 'Name the file to edit in the skill');
  assert.deepEqual(ticket.diagnosis?.evidence, [{ turn: 4, note: 'the worker skipped the skill' }]);
  assert.equal(ticket.attempts.length, 1);
  assert.equal(ticket.attempts[0]?.runId, 'failed');
  assert.equal(ticket.attempts[0]?.dashboard, '/runs/failed');
  assert.equal(ticket.attempts[0]?.failureReason, 'check-failed');
  assert.doesNotMatch(text, /transcript/i);
});

test('given a ticket with an attempt that opened a pull request, when its JSON route is requested, then the pull request is linked', async () => {
  const store = Store.open(':memory:');
  store.runs.insertRun(aRun('done', 'builder'));
  const dispatch = store.workloads.startDispatch(TICKET, 'done', '2026-11-01T10:00:00.000Z', 10, null);
  assert.ok('started' in dispatch);
  store.workloads.endDispatch(dispatch.started, { state: 'done', pullRequest: { number: 12, url: PULL.url } }, '2026-11-01T10:03:20.000Z');

  const ticket = (await (await appOver(store).request('/api/tickets/forge/7')).json()) as TicketView;
  assert.equal(ticket.outcome, 'open');
  assert.equal(ticket.failureReason, null);
  assert.deepEqual(ticket.pullRequest, { number: 12, url: PULL.url, state: 'open' });
  assert.equal(ticket.diagnosis, null);
});

test('given a ticket whose earlier attempt failed and whose latest opened a pull request, when its JSON route is requested, then the ticket carries the latest attempt first', async () => {
  const store = Store.open(':memory:');
  seedFailure(store);
  store.runs.insertRun(aRun('retry', 'builder', { startTime: '2026-11-01T10:30:00.000Z', endTime: '2026-11-01T10:40:00.000Z' }));
  const dispatch = store.workloads.startDispatch(TICKET, 'retry', '2026-11-01T10:30:00.000Z', 10, null);
  assert.ok('started' in dispatch);
  store.workloads.endDispatch(dispatch.started, { state: 'done', pullRequest: { number: 12, url: PULL.url } }, '2026-11-01T10:40:00.000Z');

  const ticket = (await (await appOver(store).request('/api/tickets/forge/7')).json()) as TicketView;
  assert.deepEqual(ticket.attempts.map(({ runId }) => runId), ['retry', 'failed']);
  assert.equal(ticket.outcome, 'open');
  assert.equal(ticket.failureReason, null);
  assert.equal(ticket.pullRequest?.number, 12);
});

test('given a ticket nothing ran against, when its JSON route is requested, then it has no attempts and no outcome', async () => {
  const ticket = (await (await appOver(Store.open(':memory:')).request('/api/tickets/forge/7')).json()) as TicketView;
  assert.deepEqual(ticket.attempts, []);
  assert.equal(ticket.outcome, null);
});

test('given a ticket number that is not a number, when its JSON route is requested, then it is not found', async () => {
  const res = await appOver(Store.open(':memory:')).request('/api/tickets/forge/seven');
  assert.equal(res.status, 404);
});

test('given a live dispatch and a live revision, when the running JSON route is requested, then both are listed with their ticket or pull request and how long each has run', async () => {
  const store = Store.open(':memory:');
  const startedAt = '2026-11-01T10:58:30.000Z';
  store.runs.insertRun(aRun('live-dispatch', 'builder', { startTime: startedAt, endTime: null }));
  assert.ok('started' in store.workloads.startDispatch(TICKET, 'live-dispatch', startedAt, 10, null));
  store.runs.insertRun(aRun('live-revision', 'reviser', { startTime: '2026-11-01T10:59:00.000Z', endTime: null }));
  assert.ok('started' in store.workloads.startRevision(PULL, [], 'live-revision', '2026-11-01T10:59:00.000Z', 10));

  const res = await appOver(store).request('/api/running');
  assert.equal(res.status, 200);
  const running = (await res.json()) as RunningView;

  assert.equal(running.dispatches.length, 1);
  assert.deepEqual(running.dispatches[0]?.ticket, TICKET);
  assert.equal(running.dispatches[0]?.runningSeconds, 90);
  assert.equal(running.dispatches[0]?.dashboard, '/runs/live-dispatch');
  assert.equal(running.revisions.length, 1);
  assert.deepEqual(running.revisions[0]?.pullRequest, PULL);
  assert.equal(running.revisions[0]?.runningSeconds, 60);
  assert.deepEqual(running.conflictResolutions, []);
});

test('given a finished dispatch, when the running JSON route is requested, then it is not listed', async () => {
  const store = Store.open(':memory:');
  seedFailure(store);
  const running = (await (await appOver(store).request('/api/running')).json()) as RunningView;
  assert.deepEqual(running, { dispatches: [], revisions: [], conflictResolutions: [] });
});

test('given one repository with an on.ticket worker and one without, when the repositories JSON route is requested, then the first carries its worker prompt template and the second carries none', async () => {
  const repositories: ManagedRepositoryView[] = [
    { name: 'forge', github: 'rameezk/forge', ticketPrompt: '/work-on {url}' },
    { name: 'notes', github: 'rameezk/notes', ticketPrompt: null },
  ];

  const res = await appOver(Store.open(':memory:'), undefined, repositories).request('/api/repositories');

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), repositories);
});

test('given the frontend app, when any non-GET request is sent to a JSON route, then it is refused and the store is unchanged', async () => {
  const store = Store.open(':memory:');
  seedFailure(store);
  const app = appOver(store);
  const before = JSON.stringify([store.workloads.listDispatches(NOW), store.runs.listRuns(), store.diagnoses.listDiagnoses(NOW)]);

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'PROPFIND']) {
    for (const path of ['/api/tickets/forge/7', '/api/running', '/api/repositories', '/api/anything']) {
      const res = await app.request(path, { method, body: '{}' });
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(res.headers.get('allow'), 'GET, HEAD');
    }
  }
  assert.equal(JSON.stringify([store.workloads.listDispatches(NOW), store.runs.listRuns(), store.diagnoses.listDiagnoses(NOW)]), before);
});

const aTicket = (number: number, overrides: Partial<Ticket> = {}): Ticket => ({
  number,
  title: `Ticket ${number}`,
  url: `https://github.com/rameezk/forge/issues/${number}`,
  parent: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  forgeReady: false,
  forHuman: false,
  blocked: false,
  blockedBy: [],
  assignees: [],
  ...overrides,
});

const OCTOCAT = { login: 'octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4' };

test('given a stored frontier snapshot holding a frontier, a queued and an assigned ticket, when the frontier JSON route is requested, then each is listed under its kind and the assigned one carries its assignees', async () => {
  const store = Store.open(':memory:');
  store.frontier.replaceFrontier({
    repository: 'forge',
    github: 'rameezk/forge',
    polledAt: NOW,
    tickets: [
      aTicket(1),
      aTicket(2, { forgeReady: true }),
      aTicket(3, { assignees: [OCTOCAT] }),
      aTicket(4, { forgeReady: true, blocked: true, blockedBy: [1] }),
      aTicket(5, { blocked: true, blockedBy: [1] }),
      aTicket(6, { forHuman: true }),
      aTicket(7, { forHuman: true, forgeReady: true }),
    ],
    closed: [],
    requests: [],
  });

  const res = await appOver(store).request('/api/frontier');
  assert.equal(res.status, 200);
  const { repositories } = (await res.json()) as FrontierView;

  assert.equal(repositories.length, 1);
  const [forge] = repositories;
  assert.equal(forge?.repository, 'forge');
  assert.deepEqual(forge?.frontier.map(({ number, readyFor }) => [number, readyFor]), [[1, 'agent'], [6, 'human'], [7, 'human']]);
  assert.deepEqual(forge?.queued.map(({ number, blockedBy }) => [number, blockedBy]), [[2, []], [4, [1]]]);
  assert.deepEqual(forge?.assigned.map(({ number, assignees }) => [number, assignees]), [[3, [OCTOCAT]]]);
  assert.equal(forge?.frontier[0]?.url, 'https://github.com/rameezk/forge/issues/1');
});

test('given a repository whose last poll failed and one whose default branch rules pass, when each repository JSON route is requested, then the first reports the failure and the second reports it polls with passing rules', async () => {
  const store = Store.open(':memory:');
  store.frontier.recordFrontierError({ repository: 'broken', github: 'rameezk/broken', message: 'GitHub answered 502', failedAt: NOW });
  store.frontier.replaceFrontier({ repository: 'forge', github: 'rameezk/forge', polledAt: NOW, tickets: [], closed: [], requests: [] });
  store.frontier.recordBranchRules({ repository: 'forge', github: 'rameezk/forge', failures: [] });
  store.frontier.replaceFrontier({ repository: 'strict', github: 'rameezk/strict', polledAt: NOW, tickets: [], closed: [], requests: [] });
  store.frontier.recordBranchRules({ repository: 'strict', github: 'rameezk/strict', failures: ['its default branch does not require an approving review'] });
  const app = appOver(store);

  const broken = (await (await app.request('/api/repositories/broken')).json()) as RepositoryView;
  assert.equal(broken.polling, false);
  assert.deepEqual(broken.lastError, { message: 'GitHub answered 502', failedAt: NOW });
  assert.equal(broken.rulesPass, null);

  const forge = (await (await app.request('/api/repositories/forge')).json()) as RepositoryView;
  assert.equal(forge.github, 'rameezk/forge');
  assert.equal(forge.polling, true);
  assert.equal(forge.polledAt, NOW);
  assert.equal(forge.lastError, null);
  assert.equal(forge.rulesPass, true);
  assert.deepEqual(forge.ruleFailures, []);

  const strict = (await (await app.request('/api/repositories/strict')).json()) as RepositoryView;
  assert.equal(strict.rulesPass, false);
  assert.deepEqual(strict.ruleFailures, ['its default branch does not require an approving review']);
});

test('given a repository forge does not manage, when its JSON route is requested, then it is not found', async () => {
  assert.equal((await appOver(Store.open(':memory:')).request('/api/repositories/ghost')).status, 404);
});

test('given the frontier and repository JSON routes, when a non-GET request is sent to them, then it is refused', async () => {
  const app = appOver(Store.open(':memory:'));
  for (const path of ['/api/frontier', '/api/repositories/forge']) {
    assert.equal((await app.request(path, { method: 'POST' })).status, 405, path);
  }
});
