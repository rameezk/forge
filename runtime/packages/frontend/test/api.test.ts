import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import type { RunRecord, RunningView, TicketView } from '@forge/shared';
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

const appOver = (store: Store, clock = () => new Date(NOW)) =>
  createApp({ store, transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))), css: '', logo: '', idiomorph: '', client: '', clock });

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

test('given the frontend app, when any non-GET request is sent to a JSON route, then it is refused and the store is unchanged', async () => {
  const store = Store.open(':memory:');
  seedFailure(store);
  const app = appOver(store);
  const before = JSON.stringify([store.workloads.listDispatches(NOW), store.runs.listRuns(), store.diagnoses.listDiagnoses(NOW)]);

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const path of ['/api/tickets/forge/7', '/api/running', '/api/anything']) {
      const res = await app.request(path, { method, body: '{}' });
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(res.headers.get('allow'), 'GET, HEAD');
    }
  }
  assert.equal(JSON.stringify([store.workloads.listDispatches(NOW), store.runs.listRuns(), store.diagnoses.listDiagnoses(NOW)]), before);
});
