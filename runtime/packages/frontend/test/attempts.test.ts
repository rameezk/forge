import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintHash, Store } from '@forge/shared';
import type { ConfigFingerprint, PullRequestState, ConflictResolutionFailureRecord, RevisionFailureRecord, RunRecord, RunStatus } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { textOf } from './html.ts';

const SONNET: ConfigFingerprint = {
  model: 'anthropic/claude-sonnet-5.5',
  reasoningEffort: 'high',
  harnessArgs: [],
  harnessVersion: '1.0.0',
  promptTemplate: '3fa2c9d1',
  systemPrompt: 's',
  tools: 't',
  skills: 'k',
};

const GLM: ConfigFingerprint = {
  ...SONNET,
  model: 'z-ai/glm-5',
  reasoningEffort: null,
  promptTemplate: '9b1e77aa',
};

const GITHUB = 'https://github.com/rameezk/';
const TICKET = { repository: 'forge', number: 42, url: `${GITHUB}forge/issues/42` };

interface Attempt {
  id: string;
  fingerprint: ConfigFingerprint;
  baseCommit: string | null;
  start: string;
  seconds: number;
  cost: number;
  status?: RunStatus;
  counters: { toolCalls: number; failedToolResults: number; retries: number; compactions: number };
  pullRequest?: { number: number; state: PullRequestState };
  ticket?: { repository: string; number: number; url: string };
}

const runOf = (attempt: Attempt): RunRecord => ({
  id: attempt.id,
  worker: 'builder',
  harness: 'pi',
  model: attempt.fingerprint.model,
  reasoningEffort: attempt.fingerprint.reasoningEffort,
  startTime: attempt.start,
  endTime: new Date(Date.parse(attempt.start) + attempt.seconds * 1000).toISOString(),
  status: attempt.status ?? 'success',
  costStatus: 'billed',
  costUsd: attempt.cost,
  costEstimated: false,
  unconfirmedEstimateUsd: 0,
  listPrice: null,
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  transcriptRef: null,
  sessionId: null,
  error: null,
  ticket: attempt.ticket ?? TICKET,
  aliveAt: null,
  harnessStartTime: null,
  timeoutSeconds: null,
  exceededLimit: null,
  counters: attempt.counters,
  maxCostUsd: null,
});

const seed = (store: Store, attempts: Attempt[]): void => {
  for (const attempt of attempts) {
    const run = runOf(attempt);
    store.insertRun(run);
    store.recordFingerprint(attempt.id, {
      fingerprint: attempt.fingerprint,
      hash: fingerprintHash(attempt.fingerprint),
      forgeGitSha: null,
      baseCommit: attempt.baseCommit,
    });
    const started = store.startDispatch(run.ticket!, attempt.id, run.startTime, 100);
    assert.ok('started' in started);
    store.endDispatch(
      started.started,
      attempt.pullRequest === undefined
        ? { state: 'failed', reason: 'no-pull-request', detail: null }
        : { state: 'done', pullRequest: { number: attempt.pullRequest.number, url: `${GITHUB}forge/pull/${attempt.pullRequest.number}` } },
      run.endTime!,
    );
    if (attempt.pullRequest !== undefined && attempt.pullRequest.state !== 'open') {
      store.recordPullRequest(started.started, { state: attempt.pullRequest.state, settledAt: run.endTime, rework: 0 });
    }
  }
};

const dashboard = (attempts: Attempt[]) => {
  const store = Store.open(':memory:');
  seed(store, attempts);
  const app = createApp({
    store,
    transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))),
    css: '',
    logo: '',
    idiomorph: '',
    client: '',
  });
  return { store, app };
};

const THREE: Attempt[] = [
  {
    id: 'run-a',
    fingerprint: SONNET,
    baseCommit: 'aaaaaaa1111111111111111111111111111111aa',
    start: '2026-09-21T10:00:00.000Z',
    seconds: 600,
    cost: 1.5,
    counters: { toolCalls: 40, failedToolResults: 2, retries: 1, compactions: 0 },
    pullRequest: { number: 7, state: 'closed' },
  },
  {
    id: 'run-b',
    fingerprint: GLM,
    baseCommit: 'bbbbbbb2222222222222222222222222222222bb',
    start: '2026-09-22T10:00:00.000Z',
    seconds: 300,
    cost: 0.25,
    status: 'error',
    counters: { toolCalls: 10, failedToolResults: 5, retries: 3, compactions: 1 },
  },
  {
    id: 'run-c',
    fingerprint: SONNET,
    baseCommit: null,
    start: '2026-09-23T10:00:00.000Z',
    seconds: 900,
    cost: 2,
    counters: { toolCalls: 55, failedToolResults: 0, retries: 0, compactions: 2 },
    pullRequest: { number: 9, state: 'merged' },
  },
];

const attemptRows = (page: string): Map<string, Record<string, string>> =>
  new Map(
    [...page.matchAll(/<tr[^>]*\sdata-attempt="([^"]*)"[^>]*>([\s\S]*?)<\/tr>/g)].map(([, id, body]) => [
      id!,
      Object.fromEntries(
        [...body!.matchAll(/<td[^>]*\sdata-field="([^"]*)"[^>]*>([\s\S]*?)<\/td>/g)].map(([, field, cell]) => [field!, cell!]),
      ),
    ]),
  );

test('given three dispatches of one ticket under two cohorts with different outcomes, when the ticket attempts view is requested, then all three are listed with cohort, base commit, outcome, cost, duration, counters and pull request link', async () => {
  const { app } = dashboard(THREE);

  const res = await app.request('/tickets/forge/42');
  assert.equal(res.status, 200);
  const rows = attemptRows(await res.text());
  assert.deepEqual([...rows.keys()], ['run-c', 'run-b', 'run-a']);

  const [a, b, c] = ['run-a', 'run-b', 'run-c'].map((id) => rows.get(id)!);
  assert.equal(textOf(a!['cohort']!), 'sonnet-5.5 · high · prompt#3fa2');
  assert.equal(textOf(b!['cohort']!), 'glm-5 · default · prompt#9b1e');
  assert.equal(textOf(a!['base-commit']!), 'aaaaaaa');
  assert.equal(textOf(c!['base-commit']!), 'not recorded');
  assert.equal(textOf(a!['outcome']!), 'closed');
  assert.equal(textOf(b!['outcome']!), 'failed');
  assert.equal(textOf(c!['outcome']!), 'merged');
  assert.equal(textOf(a!['cost']!), '$1.500000');
  assert.equal(textOf(a!['duration']!), '10m 0s');
  assert.deepEqual(
    [...b!['counters']!.matchAll(/<span[^>]*\sdata-counter[^>]*>([\s\S]*?)<\/span>/g)].map(([, item]) => textOf(item!)),
    ['10 tool calls', '5 failed', '3 retries', '1 compaction'],
  );
  assert.match(a!['pull-request']!, /<a href="https:\/\/github\.com\/rameezk\/forge\/pull\/7"[^>]*>#7<\/a>/);
  assert.equal(textOf(b!['pull-request']!), '');
  assert.match(a!['run']!, /<a href="\/runs\/run-a"/);
});

test('given a ticket with no attempts, when its attempts view is requested, then it says so', async () => {
  const { app } = dashboard([]);
  const res = await app.request('/tickets/forge/42');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(textOf(body), /No attempts/);
  assert.match(body, /<a href="\/"[^>]*>&larr; Board<\/a>/);
});

test('given a dispatched workload, when its run detail page and the Board are requested, then both link to its ticket attempts view', async () => {
  const { app, store } = dashboard(THREE.slice(0, 1));
  store.replaceFrontier({
    repository: 'forge',
    github: 'rameezk/forge',
    polledAt: '2026-09-29T08:15:00.000Z',
    closed: [], requests: [],
    tickets: [
      { number: 42, title: 'Ticket', url: TICKET.url, parent: null, createdAt: '2026-09-28T10:07:58Z', forgeReady: true, forHuman: false, blocked: false, blockedBy: [] },
    ],
  });

  const detail = await (await app.request('/runs/run-a')).text();
  assert.match(detail, /<a href="\/tickets\/forge\/42"[^>]*data-attempts[^>]*>/);
  const work = await (await app.request('/')).text();
  assert.match(work, /<a href="\/tickets\/forge\/42"[^>]*data-attempts[^>]*>/);
});

test('given a manual workload with no ticket, when its run detail page is requested, then it has no attempts link', async () => {
  const { app, store } = dashboard([]);
  store.insertRun({ ...runOf({ ...THREE[0]!, id: 'manual' }), ticket: null });
  const detail = await (await app.request('/runs/manual')).text();
  assert.doesNotMatch(detail, /data-attempts/);
});

test('given attempts that ended interrupted and exceeded without a pull request, when the ticket attempts view is requested, then each outcome names how it ended', async () => {
  const { app } = dashboard([
    { ...THREE[1]!, id: 'run-i', status: 'interrupted' },
    { ...THREE[1]!, id: 'run-x', status: 'exceeded', start: '2026-09-24T10:00:00.000Z' },
  ]);

  const rows = attemptRows(await (await app.request('/tickets/forge/42')).text());

  assert.equal(textOf(rows.get('run-i')!['outcome']!), 'interrupted');
  assert.equal(textOf(rows.get('run-x')!['outcome']!), 'exceeded');
});

test('given a ticket number that is not a plain positive integer, when its attempts view is requested, then it is not found', async () => {
  const { app } = dashboard([]);

  for (const number of ['0', '007', '1e2', '-3', '4.5', 'x']) {
    assert.equal((await app.request(`/tickets/forge/${number}`)).status, 404, number);
  }
});

test('given a ticket whose only dispatch never started a workload, when the Board is requested, then it does not link to an attempts view with nothing in it', async () => {
  const { app, store } = dashboard([]);
  store.reconcileDispatch(TICKET, '2026-09-29T08:00:00.000Z');
  store.replaceFrontier({
    repository: 'forge',
    github: 'rameezk/forge',
    polledAt: '2026-09-29T08:15:00.000Z',
    closed: [], requests: [],
    tickets: [
      { number: 42, title: 'Ticket', url: TICKET.url, parent: null, createdAt: '2026-09-28T10:07:58Z', forgeReady: true, forHuman: false, blocked: false, blockedBy: [] },
    ],
  });

  const work = await (await app.request('/')).text();

  assert.match(work, /data-column="failed"[^>]*>(?:(?!data-column=)[\s\S])*<article/);
  assert.doesNotMatch(work, /data-attempts/);
});

test('given a ticket with an earlier attempt that was dispatched again with no workload yet, when the Board is requested, then it still links to the attempts view', async () => {
  const { app, store } = dashboard(THREE.slice(0, 1));
  const again = store.startDispatch(TICKET, 'not-started', '2026-09-30T08:00:00.000Z', 100);
  assert.ok('started' in again);
  store.replaceFrontier({
    repository: 'forge',
    github: 'rameezk/forge',
    polledAt: '2026-09-30T08:15:00.000Z',
    closed: [], requests: [],
    tickets: [
      { number: 42, title: 'Ticket', url: TICKET.url, parent: null, createdAt: '2026-09-28T10:07:58Z', forgeReady: true, forHuman: false, blocked: false, blockedBy: [] },
    ],
  });

  const work = await (await app.request('/')).text();

  assert.match(work, /<article[^>]*\sdata-ticket="42"/);
  assert.match(work, /<a href="\/tickets\/forge\/42"[^>]*data-attempts[^>]*>/);
});

const revise = (
  store: Store,
  runId: string,
  start: string,
  state: 'done' | 'failed',
  pullRequest = 9,
  failure?: RevisionFailureRecord,
): void => {
  store.insertRun({
    ...runOf({ ...THREE[0]!, id: runId, start, seconds: 120, cost: 0.5 }),
    worker: 'reviser',
    ticket: null,
  });
  const started = store.startRevision(
    { repository: 'forge', number: pullRequest, url: `${GITHUB}forge/pull/${pullRequest}` },
    [TICKET.number],
    runId,
    start,
    10,
  );
  assert.ok('started' in started);
  store.endRevision(started.started, state, new Date(Date.parse(start) + 120_000).toISOString(), failure);
};

const revisionRows = (page: string): Map<string, Record<string, string>> =>
  new Map(
    [...page.matchAll(/<tr[^>]*\sdata-revision="([^"]*)"[^>]*>([\s\S]*?)<\/tr>/g)].map(([, id, body]) => [
      id!,
      Object.fromEntries(
        [...body!.matchAll(/<td[^>]*\sdata-field="([^"]*)"[^>]*>([\s\S]*?)<\/td>/g)].map(([, field, cell]) => [field!, cell!]),
      ),
    ]),
  );

test('given a ticket whose second attempt opened a pull request revised twice, when its attempts view is requested, then that attempt lists both revisions in order with outcome, cost and duration linking to their runs, and the first attempt lists none', async () => {
  const { app, store } = dashboard([
    { ...THREE[0]!, id: 'first', pullRequest: { number: 7, state: 'closed' } },
    { ...THREE[2]!, id: 'second', pullRequest: { number: 9, state: 'open' } },
  ]);
  revise(store, 'rev-ok', '2026-09-24T10:00:00.000Z', 'done');
  revise(store, 'rev-error', '2026-09-25T10:00:00.000Z', 'failed');

  const page = await (await app.request('/tickets/forge/42')).text();

  const rows = revisionRows(page);
  assert.deepEqual([...rows.keys()], ['rev-ok', 'rev-error']);
  assert.match(rows.get('rev-ok')!['run']!, /<a href="\/runs\/rev-ok"/);
  assert.equal(textOf(rows.get('rev-ok')!['outcome']!), 'done');
  assert.equal(textOf(rows.get('rev-error')!['outcome']!), 'failed');
  assert.equal(textOf(rows.get('rev-ok')!['cost']!), '$0.500000');
  assert.equal(textOf(rows.get('rev-ok')!['duration']!), '2m 0s');
  const order = [...page.matchAll(/data-(attempt|revision)="([^"]*)"/g)].map(([, , id]) => id);
  assert.deepEqual(order, ['second', 'rev-ok', 'rev-error', 'first']);
});

test('given an attempt with a revision that failed as unanswered with a detail, when its attempts view is requested, then the revision shows its reason and detail beside its state, and a revision that ended ok shows neither', async () => {
  const { app, store } = dashboard([{ ...THREE[2]!, id: 'second', pullRequest: { number: 9, state: 'open' } }]);
  revise(store, 'rev-ok', '2026-09-24T10:00:00.000Z', 'done');
  revise(store, 'rev-unanswered', '2026-09-25T10:00:00.000Z', 'failed', 9, {
    reason: 'unanswered',
    detail: 'https://github.com/rameezk/forge/pull/9#issuecomment-1',
  });

  const rows = revisionRows(await (await app.request('/tickets/forge/42')).text());

  assert.equal(
    textOf(rows.get('rev-unanswered')!['outcome']!),
    'failed Unanswered: https://github.com/rameezk/forge/pull/9#issuecomment-1',
  );
  assert.equal(textOf(rows.get('rev-ok')!['outcome']!), 'done');
});

test('given an attempt with a revision that crashed with a multi-line detail, when its attempts view is requested, then the revision shows the same Crashed: detail text as the workloads list', async () => {
  const { app, store } = dashboard([{ ...THREE[2]!, id: 'second', pullRequest: { number: 9, state: 'open' } }]);
  const detail = 'GitHub rejected the FeedbackAnswers query\nfor rameezk/forge#9: boom';
  revise(store, 'rev-crashed', '2026-09-25T10:00:00.000Z', 'failed', 9, { reason: 'crashed', detail });

  const rows = revisionRows(await (await app.request('/tickets/forge/42')).text());

  assert.equal(
    textOf(rows.get('rev-crashed')!['outcome']!),
    'failed Crashed: GitHub rejected the FeedbackAnswers query for rameezk/forge#9: boom',
  );
});

test('given a revision of a pull request no ticket dispatch opened, when the ticket attempts view is requested, then it shows no revisions', async () => {
  const { app, store } = dashboard([{ ...THREE[0]!, id: 'first', pullRequest: { number: 7, state: 'open' } }]);
  revise(store, 'manual-rev', '2026-09-24T10:00:00.000Z', 'done', 99);

  assert.deepEqual([...revisionRows(await (await app.request('/tickets/forge/42')).text()).keys()], []);
});

test('given a revision run, when its run detail page is requested, then it shows the pull request it revised linked to GitHub', async () => {
  const { app, store } = dashboard([]);
  revise(store, 'rev-ok', '2026-09-24T10:00:00.000Z', 'done', 143);

  const detail = await (await app.request('/runs/rev-ok')).text();

  assert.match(detail, /<dd[^>]*data-revised-pull-request[^>]*>[\s\S]*?<a href="https:\/\/github\.com\/rameezk\/forge\/pull\/143"[^>]*>#143<\/a>/);
});

const resolve = (
  store: Store,
  runId: string,
  start: string,
  state: 'done' | 'failed',
  pullRequest = 9,
  failure?: ConflictResolutionFailureRecord,
): void => {
  store.insertRun({
    ...runOf({ ...THREE[0]!, id: runId, start, seconds: 120, cost: 0.5 }),
    worker: 'resolver',
    ticket: null,
  });
  const started = store.startConflictResolution(
    { repository: 'forge', number: pullRequest, url: `${GITHUB}forge/pull/${pullRequest}` },
    [TICKET.number],
    runId,
    start,
    10,
    { headSha: 'head-a', defaultSha: 'default-a' },
  );
  assert.ok('started' in started);
  store.endConflictResolution(started.started, state, new Date(Date.parse(start) + 120_000).toISOString(), failure);
};

const conflictResolutionRows = (page: string): Map<string, Record<string, string>> =>
  new Map(
    [...page.matchAll(/<tr[^>]*\sdata-conflict-resolution="([^"]*)"[^>]*>([\s\S]*?)<\/tr>/g)].map(([, id, body]) => [
      id!,
      Object.fromEntries(
        [...body!.matchAll(/<td[^>]*\sdata-field="([^"]*)"[^>]*>([\s\S]*?)<\/td>/g)].map(([, field, cell]) => [field!, cell!]),
      ),
    ]),
  );

test('given a dispatch whose pull request had a revision and failed and ok conflict resolutions, when its attempts view is requested, then each conflict resolution nests under that dispatch beside the revision, labelled conflict resolution, with its state and failure reason', async () => {
  const { app, store } = dashboard([
    { ...THREE[0]!, id: 'first', pullRequest: { number: 7, state: 'closed' } },
    { ...THREE[2]!, id: 'second', pullRequest: { number: 9, state: 'open' } },
  ]);
  revise(store, 'rev-ok', '2026-09-24T10:00:00.000Z', 'done');
  resolve(store, 'res-ok', '2026-09-25T10:00:00.000Z', 'done');
  resolve(store, 'res-not-merged', '2026-09-26T10:00:00.000Z', 'failed', 9, {
    reason: 'not-merged',
    detail: 'the pull request does not contain abc1234',
  });
  resolve(store, 'res-still', '2026-09-27T10:00:00.000Z', 'failed', 9, { reason: 'still-conflicting', detail: null });
  resolve(store, 'res-crashed', '2026-09-28T10:00:00.000Z', 'failed', 9, { reason: 'crashed', detail: 'boom' });

  const page = await (await app.request('/tickets/forge/42')).text();

  const rows = conflictResolutionRows(page);
  assert.deepEqual([...rows.keys()], ['res-ok', 'res-not-merged', 'res-still', 'res-crashed']);
  assert.match(rows.get('res-ok')!['run']!, /<a href="\/runs\/res-ok"/);
  assert.match(textOf(rows.get('res-ok')!['run']!), /conflict resolution$/);
  assert.equal(textOf(rows.get('res-ok')!['outcome']!), 'done');
  assert.equal(textOf(rows.get('res-not-merged')!['outcome']!), 'failed Not merged: the pull request does not contain abc1234');
  assert.equal(textOf(rows.get('res-still')!['outcome']!), 'failed Still conflicting');
  assert.equal(textOf(rows.get('res-crashed')!['outcome']!), 'failed Crashed: boom');
  assert.equal(textOf(rows.get('res-ok')!['cost']!), '$0.500000');
  const order = [...page.matchAll(/data-(attempt|revision|conflict-resolution)="([^"]*)"/g)].map(([, , id]) => id);
  assert.deepEqual(order, ['second', 'rev-ok', 'res-ok', 'res-not-merged', 'res-still', 'res-crashed', 'first']);
});

const failToStart = (store: Store, at: string, detail: string, pullRequest = 9): void => {
  const started = store.startConflictResolution(
    { repository: 'forge', number: pullRequest, url: `${GITHUB}forge/pull/${pullRequest}` },
    [TICKET.number],
    `unused-${at}`,
    at,
    10,
    { headSha: 'head-a', defaultSha: 'default-a' },
  );
  assert.ok('started' in started);
  store.failConflictResolutionStart(started.started, detail, at);
};

const failedStartRows = (page: string): string[] =>
  [...page.matchAll(/<tr[^>]*\sdata-failed-start="[^"]*"[^>]*>([\s\S]*?)<\/tr>/g)].map(([row]) => row!);

test('given a dispatch whose pull request had a conflict resolution that failed to start twice, when its attempts view is requested, then one row shows it as a conflict resolution with its state, reason, count and detail and no run link or run columns', async () => {
  const { app, store } = dashboard([{ ...THREE[2]!, id: 'second', pullRequest: { number: 9, state: 'open' } }]);
  failToStart(store, '2026-09-25T10:00:00.000Z', 'first clone error');
  failToStart(store, '2026-09-25T10:05:00.000Z', 'fatal: unable to access the repository');

  const page = await (await app.request('/tickets/forge/42')).text();

  const [row, ...others] = failedStartRows(page);
  assert.deepEqual(others, []);
  assert.doesNotMatch(row!, /\/runs\//);
  assert.match(textOf(row!), /conflict resolution/);
  assert.match(
    textOf(/<td[^>]*data-field="outcome"[^>]*>([\s\S]*?)<\/td>/.exec(row!)![1]!),
    /^failed Did not start \(2 times\): fatal: unable to access the repository$/,
  );
  assert.equal(textOf(/<td[^>]*data-field="cost"[^>]*>([\s\S]*?)<\/td>/.exec(row!)![1]!), '');
  assert.equal(textOf(/<td[^>]*data-field="duration"[^>]*>([\s\S]*?)<\/td>/.exec(row!)![1]!), '');
});

test('given a dispatch whose pull request has a conflict resolution that failed to start, when the Board is requested, then the ticket card is flagged with the failed-start count', async () => {
  const { app, store } = dashboard([{ ...THREE[2]!, id: 'second', pullRequest: { number: 9, state: 'open' } }]);
  store.replaceFrontier({
    repository: 'forge',
    github: 'rameezk/forge',
    polledAt: '2026-09-29T08:15:00.000Z',
    closed: [], requests: [],
    tickets: [
      { number: 42, title: 'Ticket', url: TICKET.url, parent: null, createdAt: '2026-09-28T10:07:58Z', forgeReady: true, forHuman: false, blocked: false, blockedBy: [] },
    ],
  });
  failToStart(store, '2026-09-25T10:00:00.000Z', 'first');
  failToStart(store, '2026-09-25T10:05:00.000Z', 'fatal: unable to access the repository');

  const board = await (await app.request('/')).text();

  const card = /<article[^>]*\sdata-ticket="42"[\s\S]*?<\/article>/.exec(board)![0];
  assert.match(card, /PR #9/);
  assert.match(textOf(/<p[^>]*data-conflict-failed-start[^>]*>[\s\S]*?<\/p>/.exec(card)![0]), /^Conflict resolution did not start \(2 times, last .* ago\): fatal: unable to access the repository$/);
});

test('given a conflict resolution that failed to start and is now running again, when the Board is requested, then the ticket card is in Running without the failed-start flag', async () => {
  const { app, store } = dashboard([{ ...THREE[2]!, id: 'second', pullRequest: { number: 9, state: 'open' } }]);
  store.replaceFrontier({
    repository: 'forge',
    github: 'rameezk/forge',
    polledAt: '2026-09-29T08:15:00.000Z',
    closed: [], requests: [],
    tickets: [
      { number: 42, title: 'Ticket', url: TICKET.url, parent: null, createdAt: '2026-09-28T10:07:58Z', forgeReady: true, forHuman: false, blocked: false, blockedBy: [] },
    ],
  });
  failToStart(store, '2026-09-25T10:00:00.000Z', 'fatal: unable to access the repository');
  const again = store.startConflictResolution(
    { repository: 'forge', number: 9, url: `${GITHUB}forge/pull/9` },
    [TICKET.number],
    'retry-run',
    new Date().toISOString(),
    10,
    { headSha: 'head-a', defaultSha: 'default-a' },
  );
  assert.ok('started' in again);

  const board = await (await app.request('/')).text();

  assert.match(board, /<div[^>]*data-column="running"[\s\S]*?data-ticket="42"/);
  assert.doesNotMatch(board, /data-conflict-failed-start/);
});

const failRevisionToStart = (store: Store, at: string, detail: string, pullRequest = 9): void => {
  const started = store.startRevision(
    { repository: 'forge', number: pullRequest, url: `${GITHUB}forge/pull/${pullRequest}` },
    [TICKET.number],
    `unused-${at}`,
    at,
    10,
  );
  assert.ok('started' in started);
  store.failRevisionStart(started.started, detail, at);
};

const frontierWithTicket = (store: Store): void =>
  store.replaceFrontier({
    repository: 'forge',
    github: 'rameezk/forge',
    polledAt: '2026-09-29T08:15:00.000Z',
    closed: [], requests: [],
    tickets: [
      { number: 42, title: 'Ticket', url: TICKET.url, parent: null, createdAt: '2026-09-28T10:07:58Z', forgeReady: true, forHuman: false, blocked: false, blockedBy: [] },
    ],
  });

test('given a dispatch whose pull request had a revision that failed to start twice, when its attempts view is requested, then one row shows it as a revision with its state, reason, count and detail and no run link or run columns', async () => {
  const { app, store } = dashboard([{ ...THREE[2]!, id: 'second', pullRequest: { number: 9, state: 'open' } }]);
  failRevisionToStart(store, '2026-09-25T10:00:00.000Z', 'first clone error');
  failRevisionToStart(store, '2026-09-25T10:05:00.000Z', 'GitHub answered 401: Bad credentials');

  const page = await (await app.request('/tickets/forge/42')).text();

  const [row, ...others] = failedStartRows(page);
  assert.deepEqual(others, []);
  assert.doesNotMatch(row!, /\/runs\//);
  assert.match(textOf(row!), /revision/);
  assert.doesNotMatch(textOf(row!), /conflict resolution/);
  assert.match(
    textOf(/<td[^>]*data-field="outcome"[^>]*>([\s\S]*?)<\/td>/.exec(row!)![1]!),
    /^failed Did not start \(2 times\): GitHub answered 401: Bad credentials$/,
  );
  assert.equal(textOf(/<td[^>]*data-field="cost"[^>]*>([\s\S]*?)<\/td>/.exec(row!)![1]!), '');
  assert.equal(textOf(/<td[^>]*data-field="duration"[^>]*>([\s\S]*?)<\/td>/.exec(row!)![1]!), '');
});

test('given a dispatch whose pull request has a revision that failed to start, when the Board is requested, then the ticket card is flagged with the failed-start count', async () => {
  const { app, store } = dashboard([{ ...THREE[2]!, id: 'second', pullRequest: { number: 9, state: 'open' } }]);
  frontierWithTicket(store);
  failRevisionToStart(store, '2026-09-25T10:00:00.000Z', 'first');
  failRevisionToStart(store, '2026-09-25T10:05:00.000Z', 'GitHub answered 401: Bad credentials');

  const board = await (await app.request('/')).text();

  const card = /<article[^>]*\sdata-ticket="42"[\s\S]*?<\/article>/.exec(board)![0];
  assert.match(textOf(/<p[^>]*data-revision-failed-start[^>]*>[\s\S]*?<\/p>/.exec(card)![0]), /^Revision did not start \(2 times, last .* ago\): GitHub answered 401: Bad credentials$/);
  assert.doesNotMatch(card, /data-conflict-failed-start/);
});

test('given a revision that failed to start and then ran, when the Board is requested, then the ticket card is not flagged', async () => {
  const { app, store } = dashboard([{ ...THREE[2]!, id: 'second', pullRequest: { number: 9, state: 'open' } }]);
  frontierWithTicket(store);
  failRevisionToStart(store, '2026-09-25T10:00:00.000Z', 'clone failed');
  const ran = store.startRevision({ repository: 'forge', number: 9, url: `${GITHUB}forge/pull/9` }, [TICKET.number], 'ran', '2026-09-25T11:00:00.000Z', 10);
  assert.ok('started' in ran);
  store.endRevision(ran.started, 'done', '2026-09-25T11:05:00.000Z');

  assert.doesNotMatch(await (await app.request('/')).text(), /data-revision-failed-start/);
});

test('given a conflict resolution of a pull request no ticket dispatch opened, when the ticket attempts view is requested, then it shows no conflict resolutions', async () => {
  const { app, store } = dashboard([{ ...THREE[0]!, id: 'first', pullRequest: { number: 7, state: 'open' } }]);
  resolve(store, 'manual-res', '2026-09-24T10:00:00.000Z', 'done', 99);

  assert.deepEqual([...conflictResolutionRows(await (await app.request('/tickets/forge/42')).text()).keys()], []);
});

test('given a conflict resolution run, when its run detail page is requested, then it reads as a conflict resolution of its pull request linked to GitHub', async () => {
  const { app, store } = dashboard([]);
  resolve(store, 'res-ok', '2026-09-24T10:00:00.000Z', 'done', 143);

  const detail = await (await app.request('/runs/res-ok')).text();

  assert.match(detail, /<dt[^>]*>Conflict resolution of<\/dt>\s*<dd[^>]*data-resolved-pull-request[^>]*>[\s\S]*?<a href="https:\/\/github\.com\/rameezk\/forge\/pull\/143"[^>]*>#143<\/a>/);
  assert.doesNotMatch(detail, /data-revised-pull-request/);
});
