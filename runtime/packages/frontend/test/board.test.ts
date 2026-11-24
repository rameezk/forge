import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drawSample, Store } from '@forge/shared';
import type { ClosedTicket, GateKey, GradingAttempt, GradingFailure, PolledFrontier, PollFailure, RefinementRequest, RiskGrade, RunRecord, Ticket, UrgencyGrade, UrgencyLevel } from '@forge/shared';
import { createApp, FileTranscriptSource, type AppOptions } from '../src/index.ts';
import { openingTag, textOf } from './html.ts';

const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  number: 56,
  title: 'Declared repositories show their frontier on the dashboard',
  url: 'https://github.com/rameezk/forge/issues/56',
  parent: { number: 54, title: 'Frontier discovery across managed repositories', url: 'https://github.com/rameezk/forge/issues/54' },
  createdAt: '2026-09-28T10:07:58Z',
  forgeReady: false,
  blocked: false,
  forHuman: false,
  blockedBy: [],
  ...overrides,
});

type Seed =
  | (PolledFrontier & { lastError?: PollFailure; branchRules?: string[] })
  | { repository: string; github: string; polledAt: null; lastError: PollFailure };

const appWith = (frontier: Seed[], dispatch: (store: Store) => void = () => {}, maxConcurrent?: number, maxOpenPullRequests?: number | null, gradingRepositories?: string[], extra: Partial<AppOptions> = {}) => {
  const store = Store.open(':memory:');
  dispatch(store);
  for (const seed of frontier) {
    if (seed.polledAt !== null) store.replaceFrontier(seed);
    if ('branchRules' in seed && seed.branchRules !== undefined) {
      store.recordBranchRules({ repository: seed.repository, github: seed.github, failures: seed.branchRules });
    }
    if (seed.lastError !== undefined) {
      store.recordFrontierError({ repository: seed.repository, github: seed.github, ...seed.lastError });
    }
  }
  return createApp({
    store,
    transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))),
    css: '',
    logo: '',
    idiomorph: '',
    client: '',
    ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
    ...(maxOpenPullRequests === undefined ? {} : { maxOpenPullRequests }),
    ...(gradingRepositories === undefined ? {} : { gradingRepositories }),
    ...extra,
  });
};

const sections = (body: string): string[] =>
  body.match(/<section[^>]*\sdata-repository="[^"]*"[\s\S]*?<\/section>/g) ?? [];

const ticketRows = (section: string): string[] =>
  section.match(/<tr[^>]*\sdata-ticket="[^"]*"[\s\S]*?<\/tr>/g) ?? [];

test('given the dashboard, when / and /work are requested, then / serves the Board, /work redirects to /, and the nav reads Board, Runs, Insights with Board current and the logo linking to /', async () => {
  const app = appWith([]);

  const home = await app.request('/');
  const body = await home.text();
  assert.equal(home.status, 200);
  assert.match(body, /<title>Board \| Forge<\/title>/);
  assert.match(body, /<h1[^>]*>Board<\/h1>/);
  assert.match(body, /<a href="\/" data-brand/);
  const nav = body.match(/<nav[^>]*>[\s\S]*?<\/nav>/)?.[0] ?? '';
  assert.deepEqual(
    [...nav.matchAll(/<a href="([^"]*)"([^>]*)>([^<]*)<\/a>/g)].map(([, href, attributes, label]) => [href, label, /aria-current="page"/.test(attributes ?? '')]),
    [['/', 'Board', true], ['/workloads', 'Workloads', false], ['/insights', 'Insights', false]],
  );

  const work = await app.request('/work');
  assert.equal(work.status, 302);
  assert.equal(work.headers.get('location'), '/');

  const workloads = await (await app.request('/workloads')).text();
  assert.match(workloads.match(/<nav[^>]*>[\s\S]*?<\/nav>/)?.[0] ?? '', /<a href="\/workloads" aria-current="page"[^>]*>Workloads<\/a>/);

  const legacy = await app.request('/runs');
  assert.equal(legacy.status, 302);
  assert.equal(legacy.headers.get('location'), '/workloads');

  const filtered = await app.request('/runs?status=error&page=2');
  assert.equal(filtered.status, 302);
  assert.equal(filtered.headers.get('location'), '/workloads?status=error&page=2');
});

const columnHeaders = (body: string): string[] =>
  body.match(/<div[^>]*\sdata-column-header="[^"]*"[\s\S]*?<\/div>/g) ?? [];

test('given a stored frontier, when the Board is requested, then it shows the nine columns in order, each with its title, total and subtitle with its hint tooltip, and a person icon on To refine, Ready for human and In review only', async () => {
  const app = appWith([
    { repository: 'forge', github: 'rameezk/forge', polledAt: '2026-09-29T08:15:00.000Z', closed: [], requests: [], tickets: [ticket()] },
  ]);

  const headers = columnHeaders(await (await app.request('/')).text());

  assert.deepEqual(
    headers.map((header) => [/data-column-header="([^"]*)"/.exec(header)?.[1], /data-column-title[^>]*>([^<]*)</.exec(header)?.[1], /data-column-total[^>]*>([^<]*)</.exec(header)?.[1], /data-column-subtitle[^>]*>([^<]*)</.exec(header)?.[1], /data-column-subtitle[^>]*\stitle="([^"]*)"/.exec(header)?.[1] ?? null, /data-person/.test(header)]),
    [
      ['to-refine', 'To refine', '0', 'Needs a human in the loop', 'Needs a human in the loop', true],
      ['blocked', 'Blocked', '0', 'Waiting on open blockers', 'Waiting on open blockers', false],
      ['ready-for-human', 'Ready for human', '0', 'Needs a human in the loop', 'Needs a human in the loop', true],
      ['ready-for-agent', 'Ready for agent', '1', 'Not handed off yet', 'Add forge:ready to hand off', false],
      ['waiting-for-slot', 'Waiting for slot', '0', 'Handed off, waiting for a slot', 'Handed off, waiting for a slot', false],
      ['running', 'Running', '0', 'An agent is working on it', 'An agent is working on it', false],
      ['in-review', 'In review', '0', 'Needs a human in the loop', 'Needs a human in the loop', true],
      ['failed', 'Failed', '0', 'Agent run failed', 'Set forge:ready to retry', false],
      ['done', 'Done', '0', 'Closed in the last 7 days', 'Closed in the last 7 days', false],
    ],
  );
});

const forgeTicket = (number: number) => ({ repository: 'forge', number, url: `https://github.com/rameezk/forge/issues/${number}` });

const dispatched = (store: Store, number: number, startedAt = '2026-09-30T08:00:00.000Z'): number => {
  const start = store.workloads.startDispatch(forgeTicket(number), `run-${number}`, startedAt, Number.POSITIVE_INFINITY, null);
  assert.ok('started' in start);
  return start.started;
};

const pullRequest = (number: number) => ({ number, url: `https://github.com/rameezk/forge/pull/${number}` });

const laneOf = (body: string, repository: string): string =>
  sections(body).find((section) => openingTag(section).includes(`data-repository="${repository}"`)) ?? '';

const cardsByColumn = (lane: string): Record<string, string[]> =>
  Object.fromEntries(
    (lane.match(/<div[^>]*\sdata-column="[^"]*"[\s\S]*?<\/div>(?=\s*<div[^>]*\sdata-column=|\s*<\/div>\s*<\/section>)/g) ?? []).map((column) => [
      /data-column="([^"]*)"/.exec(column)?.[1] ?? '',
      (column.match(/<article[^>]*\sdata-ticket="[^"]*"[\s\S]*?<\/article>/g) ?? []).map((card) => /data-ticket="([^"]*)"/.exec(card)?.[1] ?? ''),
    ]),
  );

const populated = (columns: Record<string, string[]>): Record<string, string[]> =>
  Object.fromEntries(Object.entries(columns).filter(([, numbers]) => numbers.length > 0));

const frontierOf = (tickets: Ticket[], requests: RefinementRequest[] = [], closed: ClosedTicket[] = []): PolledFrontier => ({ repository: 'forge', github: 'rameezk/forge', polledAt: '2026-09-29T08:15:00.000Z', tickets, closed, requests });

const closedTicket = (overrides: Partial<ClosedTicket> = {}): ClosedTicket => ({
  number: 56,
  title: 'Declared repositories show their frontier on the dashboard',
  url: 'https://github.com/rameezk/forge/issues/56',
  parent: null,
  createdAt: '2026-09-20T10:00:00Z',
  closedAt: '2026-09-28T10:00:00Z',
  forHuman: false,
  ...overrides,
});

test('given a queued ticket, an unblocked ready-for-agent ticket not handed off, an unblocked forge:ready ticket waiting for a slot, a running dispatch, a done dispatch with an open pull request and a failed dispatch, when the Board is requested, then each lands in Blocked, Ready for agent, Waiting for slot, Running, In review and Failed respectively', async () => {
  const app = appWith(
    [
      frontierOf([
        ticket({ number: 1, forgeReady: true, blocked: true }),
        ticket({ number: 2 }),
        ticket({ number: 3, forgeReady: true }),
        ticket({ number: 4, forgeReady: true }),
        ticket({ number: 5, forgeReady: true }),
        ticket({ number: 6, forgeReady: true }),
      ]),
    ],
    (store) => {
      dispatched(store, 4, new Date().toISOString());
      store.workloads.endDispatch(dispatched(store, 5), { state: 'done', pullRequest: pullRequest(105) }, '2026-09-30T09:00:00.000Z');
      store.workloads.endDispatch(dispatched(store, 6), { state: 'failed', reason: 'errored', detail: null }, '2026-09-30T09:00:00.000Z');
    },
  );

  const columns = populated(cardsByColumn(laneOf(await (await app.request('/')).text(), 'forge')));

  assert.deepEqual(columns, {
    blocked: ['1'],
    'ready-for-agent': ['2'],
    'waiting-for-slot': ['3'],
    running: ['4'],
    'in-review': ['5'],
    failed: ['6'],
  });
});

const cardOf = (body: string, number: number): string =>
  body.match(new RegExp(`<article[^>]*\\sdata-ticket="${number}"[\\s\\S]*?</article>`))?.[0] ?? '';

test('given a done dispatch whose pull request was closed without merging while the ticket stays open, when the Board is requested, then the ticket is in Failed with the reason "Pull request closed"', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true })])], (store) => {
    const id = dispatched(store, 5);
    store.workloads.endDispatch(id, { state: 'done', pullRequest: pullRequest(105) }, '2026-09-30T09:00:00.000Z');
    store.workloads.recordPullRequest(id, { state: 'closed', settledAt: '2026-09-30T10:00:00.000Z', rework: 0 });
  });

  const body = await (await app.request('/')).text();

  assert.deepEqual(populated(cardsByColumn(laneOf(body, 'forge'))), { failed: ['5'] });
  assert.match(textOf(cardOf(body, 5)), /Pull request closed/);
});

test('given a blocked ready-for-agent ticket, a blocked forge:ready ticket and a blocked ready-for-human ticket, when the Board is requested, then all three are in Blocked, the first with no marker, the second with a queued pill and the third with a ready-for-human tag, and each says which tickets block it', async () => {
  const app = appWith([
    frontierOf([
      ticket({ number: 1, blocked: true, blockedBy: [200] }),
      ticket({ number: 2, blocked: true, blockedBy: [200, 199], forgeReady: true }),
      ticket({ number: 3, blocked: true, blockedBy: [201], forHuman: true }),
    ]),
  ]);

  const body = await (await app.request('/')).text();

  assert.deepEqual(populated(cardsByColumn(laneOf(body, 'forge'))), { blocked: ['1', '2', '3'] });
  assert.match(textOf(cardOf(body, 1)), /blocked by #200$/);
  assert.match(textOf(cardOf(body, 2)), /queued blocked by #200\s*, #199$/);
  assert.match(textOf(cardOf(body, 3)), /ready-for-human blocked by #201$/);
  assert.match(cardOf(body, 1), /<a href="https:\/\/github\.com\/rameezk\/forge\/issues\/200"[^>]*>#200<\/a>/);
  assert.doesNotMatch(cardOf(body, 1), /data-queued|data-ready-for-human/);
  assert.match(cardOf(body, 2), /data-queued/);
  assert.doesNotMatch(cardOf(body, 2), /data-ready-for-human/);
  assert.match(cardOf(body, 3), /<span[^>]*data-ready-for-human[^>]*>ready-for-human<\/span>/);
  assert.doesNotMatch(cardOf(body, 3), /data-queued/);
});

test('given an unlabelled ready-for-agent ticket whose approval does not stand, a blocked one, and one whose approval stands, when the Board is requested, then only the first two show awaiting re-dispatch, in Ready for agent and Blocked', async () => {
  const app = appWith([
    frontierOf([
      ticket({ number: 1, awaitingRedispatch: true }),
      ticket({ number: 2, blocked: true, blockedBy: [200], awaitingRedispatch: true }),
      ticket({ number: 3 }),
    ]),
  ]);

  const body = await (await app.request('/')).text();

  assert.deepEqual(populated(cardsByColumn(laneOf(body, 'forge'))), { blocked: ['2'], 'ready-for-agent': ['1', '3'] });
  assert.match(cardOf(body, 1), /<span[^>]*data-awaiting-redispatch[^>]*>awaiting re-dispatch<\/span>/);
  assert.match(cardOf(body, 2), /<span[^>]*data-awaiting-redispatch[^>]*>awaiting re-dispatch<\/span>/);
  assert.doesNotMatch(cardOf(body, 3), /data-awaiting-redispatch|awaiting re-dispatch/);
});

test('given an unblocked ready-for-human ticket, when the Board is requested, then it is in Ready for human with its created date and no blocked marker', async () => {
  const app = appWith([frontierOf([ticket({ number: 8, forHuman: true, createdAt: '2026-09-27T10:00:00Z' })])]);

  const body = await (await app.request('/')).text();

  assert.deepEqual(populated(cardsByColumn(laneOf(body, 'forge'))), { 'ready-for-human': ['8'] });
  assert.match(textOf(cardOf(body, 8)), /2026-09-27$/);
  assert.doesNotMatch(cardOf(body, 8), /data-ready-for-human/);
});

test('given a ready-for-human ticket and a forge-dispatched ticket whose pull request merged, both closed in the last 7 days, when the Board is requested, then both are in Done, most recently closed first, the dispatched one with a merged pill and its pull request number, and only the human-built one with a person marker', async () => {
  const app = appWith(
    [
      frontierOf([], [], [
        closedTicket({ number: 10, forHuman: true, closedAt: '2026-09-27T10:00:00Z' }),
        closedTicket({ number: 11, closedAt: '2026-09-28T10:00:00Z' }),
      ]),
    ],
    (store) => {
      const id = dispatched(store, 11);
      store.workloads.endDispatch(id, { state: 'done', pullRequest: pullRequest(111) }, '2026-09-28T09:00:00.000Z');
      store.workloads.recordPullRequest(id, { state: 'merged', settledAt: '2026-09-28T10:00:00.000Z', rework: 0 });
    },
  );

  const body = await (await app.request('/')).text();

  assert.deepEqual(populated(cardsByColumn(laneOf(body, 'forge'))), { done: ['11', '10'] });
  assert.match(cardOf(body, 11), /<span[^>]*data-merged[^>]*>\s*merged\s*<\/span>/);
  assert.match(cardOf(body, 11), /<a href="https:\/\/github\.com\/rameezk\/forge\/pull\/111"[^>]*>PR #111<\/a>/);
  assert.match(cardOf(body, 11), /<time datetime="2026-09-28T10:00:00Z"/);
  assert.doesNotMatch(cardOf(body, 11), /data-person/);
  assert.doesNotMatch(cardOf(body, 10), /data-merged|PR #/);
  assert.match(cardOf(body, 10), /<time datetime="2026-09-27T10:00:00Z"/);
  assert.match(cardOf(body, 10), /data-person/);
});

const runOf = (number: number): RunRecord => ({
  id: `run-${number}`,
  worker: 'builder',
  harness: 'pi',
  model: 'z-ai/glm-5',
  reasoningEffort: null,
  startTime: '2026-09-30T08:00:00.000Z',
  endTime: null,
  status: 'running',
  costStatus: 'pending',
  costUsd: 0,
  costEstimated: false,
  unconfirmedEstimateUsd: 0,
  listPrice: null,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  transcriptRef: null,
  sessionId: null,
  error: null,
  ticket: forgeTicket(number),
  aliveAt: null,
  harnessStartTime: null,
  timeoutSeconds: null,
  maxCostUsd: null,
  exceededLimit: null,
  counters: null,
});

test('given tickets with attempts, a parent spec, and dispatches in each state, when the Board is requested, then each card shows its linked number, title, attempts link and its column details, oldest first within each column', async () => {
  const app = appWith(
    [
      frontierOf([
        ticket({ number: 1, forgeReady: true, blocked: true, createdAt: '2026-09-20T10:00:00Z', parent: null }),
        ticket({ number: 2, createdAt: '2026-09-22T10:00:00Z' }),
        ticket({ number: 7, createdAt: '2026-09-21T10:00:00Z', parent: null, title: 'Older unparented' }),
        ticket({ number: 3, forgeReady: true, createdAt: '2026-09-23T10:00:00Z' }),
        ticket({ number: 4, forgeReady: true, createdAt: '2026-09-24T10:00:00Z' }),
        ticket({ number: 5, forgeReady: true, createdAt: '2026-09-25T10:00:00Z' }),
        ticket({ number: 6, forgeReady: true, createdAt: '2026-09-26T10:00:00Z' }),
      ]),
    ],
    (store) => {
      store.runs.insertRun(runOf(4));
      dispatched(store, 4, new Date().toISOString());
      store.workloads.endDispatch(dispatched(store, 5), { state: 'done', pullRequest: pullRequest(105) }, '2026-09-30T09:00:00.000Z');
      store.workloads.endDispatch(dispatched(store, 6), { state: 'failed', reason: 'no-pull-request', detail: 'Should the check use <b>REST</b>?' }, '2026-09-30T09:00:00.000Z');
    },
  );

  const body = await (await app.request('/')).text();
  const columns = cardsByColumn(laneOf(body, 'forge'));

  assert.deepEqual(columns['ready-for-agent'], ['7', '2']);
  assert.doesNotMatch(openingTag(cardOf(body, 2)), /title=/);
  assert.match(cardOf(body, 2), /<a href="https:\/\/github\.com\/rameezk\/forge\/issues\/56"[^>]*>#2<\/a>/);
  assert.match(textOf(cardOf(body, 2)), /Declared repositories show their frontier on the dashboard ↳ #54 Frontier discovery across managed repositories 2026-09-22$/);
  assert.doesNotMatch(cardOf(body, 2), /data-attempts/);

  assert.match(textOf(cardOf(body, 1)), /queued/);
  assert.match(cardOf(body, 1), /<span[^>]*data-queued[^>]*>queued<\/span>/);
  assert.match(textOf(cardOf(body, 3)), /2026-09-23$/);

  assert.match(cardOf(body, 4), /<a href="\/runs\/run-4"[^>]*><span[^>]*>running<\/span><\/a>/);
  assert.match(cardOf(body, 4), /data-elapsed-since="\d{4}-\d{2}-\d{2}T/);
  assert.match(cardOf(body, 4), /<a href="\/tickets\/forge\/4"[^>]*data-attempts[^>]*>/);

  assert.match(cardOf(body, 5), /<a href="https:\/\/github\.com\/rameezk\/forge\/pull\/105"[^>]*>PR #105<\/a>/);
  assert.doesNotMatch(cardOf(body, 5), /data-elapsed-since/);

  assert.match(textOf(cardOf(body, 6)), /No pull request: Should the check use &lt;b&gt;REST&lt;\/b&gt;\?/);
  assert.doesNotMatch(cardOf(body, 6), /<b>REST<\/b>/);
});

test('given tickets whose dispatches failed because their pull request is still a draft or a required check is red or pending, when the Board is requested, then each card shows its reason, the checks naming theirs', async () => {
  const app = appWith(
    [
      frontierOf([
        ticket({ number: 5, forgeReady: true }),
        ticket({ number: 6, forgeReady: true }),
        ticket({ number: 7, forgeReady: true }),
      ]),
    ],
    (store) => {
      store.workloads.endDispatch(dispatched(store, 5), { state: 'failed', reason: 'draft', detail: null }, '2026-09-30T09:00:00.000Z');
      store.workloads.endDispatch(dispatched(store, 6), { state: 'failed', reason: 'check-failed', detail: 'lint, vm' }, '2026-09-30T09:00:00.000Z');
      store.workloads.endDispatch(dispatched(store, 7), { state: 'failed', reason: 'check-pending', detail: 'build' }, '2026-09-30T09:00:00.000Z');
    },
  );

  const body = await (await app.request('/')).text();

  assert.match(textOf(cardOf(body, 5)), /Pull request still a draft$/);
  assert.match(textOf(cardOf(body, 6)), /Required check failed: lint, vm$/);
  assert.match(textOf(cardOf(body, 7)), /Required check pending: build$/);
});

test('given two repositories, one with a poll error, when the Board is requested, then each has its own lane with its GitHub link and last-polled time, the failing one shows its error in its lane, and each column total counts both', async () => {
  const app = appWith([
    { ...frontierOf([ticket({ number: 1 }), ticket({ number: 2, forgeReady: true })]), lastError: { message: 'GitHub answered 401 for rameezk/forge', failedAt: '2026-09-29T08:20:00.000Z' } },
    { repository: 'dotfiles', github: 'rameezk/dotfiles', polledAt: '2026-09-29T08:10:00.000Z', closed: [], requests: [], tickets: [ticket({ number: 3, url: 'https://github.com/rameezk/dotfiles/issues/3', parent: null })] },
  ]);

  const body = await (await app.request('/')).text();
  const [dotfiles, forge, ...rest] = sections(body);
  assert.deepEqual(rest, []);
  assert.ok(dotfiles && forge);

  assert.match(dotfiles, /<h2[^>]*>dotfiles<\/h2>/);
  assert.match(dotfiles, /<a href="https:\/\/github\.com\/rameezk\/dotfiles"[^>]*>rameezk\/dotfiles<\/a>/);
  assert.match(dotfiles, /Last polled <time datetime="2026-09-29T08:10:00.000Z"/);
  assert.doesNotMatch(dotfiles, /data-poll-error|data-stale/);
  assert.deepEqual(populated(cardsByColumn(dotfiles)), { 'ready-for-agent': ['3'] });

  assert.match(forge, /<h2[^>]*>forge<\/h2>/);
  assert.match(forge, /<a href="https:\/\/github\.com\/rameezk\/forge"[^>]*>rameezk\/forge<\/a>/);
  assert.match(forge, /Last polled <time datetime="2026-09-29T08:15:00.000Z"/);
  assert.match(openingTag(forge), /\sdata-stale[\s>]/);
  assert.match(forge, /<p[^>]*\sdata-poll-error[^>]*>Last poll failed <time datetime="2026-09-29T08:20:00.000Z"[^>]*>2026-09-29 08:20:00<\/time>: GitHub answered 401 for rameezk\/forge<\/p>/);
  assert.deepEqual(populated(cardsByColumn(forge)), { 'ready-for-agent': ['1'], 'waiting-for-slot': ['2'] });

  const totals = columnHeaders(body).map((header) => /data-column-total[^>]*>([^<]*)</.exec(header)?.[1]);
  assert.deepEqual(totals, ['0', '0', '0', '2', '1', '0', '0', '0', '0']);
});

test('given a repository that has never been polled, one whose github is not an owner/name, and no repositories at all, when the Board is requested, then the lane says it was never polled and renders without a link, and the empty board says nothing has been polled', async () => {
  const failure = { message: 'GitHub token missing', failedAt: '2026-09-29T08:20:00.000Z' };
  const app = appWith([
    { repository: 'forge', github: '../../evil', polledAt: null, lastError: failure },
    { repository: 'unreachable', github: 'rameezk/unreachable', polledAt: null, lastError: failure },
  ]);

  const body = await (await app.request('/')).text();
  const forge = laneOf(body, 'forge');

  assert.doesNotMatch(forge, /<a href="https:\/\/github\.com\/\.\.\/\.\.\/evil"/);
  assert.match(forge, /<span[^>]*>\.\.\/\.\.\/evil<\/span>/);
  assert.match(forge, /<span[^>]*>Never polled<\/span>/);
  assert.match(forge, /<p[^>]*\sdata-poll-error[^>]*>Last poll failed <time[^>]*>[^<]*<\/time>: GitHub token missing<\/p>/);
  assert.match(await (await appWith([]).request('/')).text(), /<p[^>]*>No managed repositories have been polled yet\.<\/p>/);
});

test('given a ticket and a parent spec whose URLs are not GitHub https links, when the Board is requested, then the card renders its number without a link', async () => {
  const app = appWith([frontierOf([ticket({ number: 1, url: 'javascript:alert(1)', parent: { number: 54, title: 'Spec', url: 'javascript:alert(2)' } })])]);

  const body = await (await app.request('/')).text();

  assert.doesNotMatch(body, /javascript:/);
  assert.match(cardOf(body, 1), /<p[^>]*>#1<\/p>/);
  assert.equal(cardLinkOf(cardOf(body, 1)), undefined);
});

const runningLimit = (body: string): string => {
  const header = body.match(/<span[^>]*\sdata-running-limit[^>]*>[^<]*<\/span>/)?.[0];
  assert.ok(header, 'the board header shows the running limit');
  return header;
};

test('given a limit of 2 with one dispatch and one revision running, when the Board is requested, then the header reads Running 2 / 2, styled as full', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true }), ticket({ number: 6, forgeReady: true })])], (store) => {
    const now = new Date().toISOString();
    dispatched(store, 4, now);
    store.workloads.endDispatch(dispatched(store, 5, now), { state: 'done', pullRequest: pullRequest(105) }, now);
    const start = store.workloads.startRevision({ repository: 'forge', ...pullRequest(105) }, [5], 'revision-105', now, Number.POSITIVE_INFINITY);
    assert.ok('started' in start);
  }, 2);

  const header = runningLimit(await (await app.request('/')).text());

  assert.equal(textOf(header).replace(/\s+/g, ' ').trim(), 'Running 2 / 2');
  assert.match(header, /data-full/);
});

test('given a limit of 2 with nothing running, when the Board is requested, then the header reads Running 0 / 2, not styled as full', async () => {
  const app = appWith([frontierOf([ticket()])], () => {}, 2);

  const header = runningLimit(await (await app.request('/')).text());

  assert.equal(textOf(header).replace(/\s+/g, ' ').trim(), 'Running 0 / 2');
  assert.doesNotMatch(header, /data-full/);
});

test('given no repositories and no configured limit, when the Board is requested, then the header reads Running 0 / 1', async () => {
  const header = runningLimit(await (await appWith([]).request('/')).text());

  assert.equal(textOf(header).replace(/\s+/g, ' ').trim(), 'Running 0 / 1');
});

test('given a repository with cards, when the Board is requested, then its lane header is a focusable expanded button carrying the non-zero column counts', async () => {
  const app = appWith([
    { repository: 'forge', github: 'rameezk/forge', polledAt: '2026-09-29T08:15:00.000Z', closed: [], requests: [], tickets: [ticket({ number: 1 }), ticket({ number: 2 }), ticket({ number: 3, blocked: true })] },
  ]);

  const lane = laneOf(await (await app.request('/')).text(), 'forge');
  const header = lane.match(/<header[^>]*\sdata-lane-toggle[^>]*>[\s\S]*?<\/header>/)?.[0] ?? '';

  assert.match(header, /role="button"/);
  assert.match(header, /tabindex="0"/);
  assert.match(header, /aria-expanded="true"/);
  assert.match(header, /<span[^>]*\sdata-lane-chevron[^>]*\saria-hidden="true"[^>]*>▶<\/span>/);
  assert.doesNotMatch(openingTag(lane), /data-empty/);
  assert.deepEqual(
    [...header.matchAll(/<span[^>]*data-lane-count="([^"]*)"[^>]*>([\s\S]*?)<\/span>/g)].map(([, key, text]) => [key, textOf(text ?? '')]),
    [['blocked', 'Blocked 1'], ['ready-for-agent', 'Ready for agent 2']],
  );
});

test('given a repository with nothing on the board, when the Board is requested, then its lane is marked empty and says it has nothing in flight', async () => {
  const app = appWith([{ repository: 'forge', github: 'rameezk/forge', polledAt: '2026-09-29T08:15:00.000Z', closed: [], requests: [], tickets: [] }]);

  const lane = laneOf(await (await app.request('/')).text(), 'forge');

  assert.match(openingTag(lane), /data-empty/);
  assert.match(lane, /data-lane-empty[^>]*>\s*Nothing in flight\s*</);
  assert.doesNotMatch(lane, /data-lane-count/);
});

const request = (overrides: Partial<RefinementRequest> = {}): RefinementRequest => ({
  number: 146,
  title: 'Give each forge unit only the state directory access it needs',
  url: 'https://github.com/rameezk/forge/issues/146',
  createdAt: '2026-10-01T06:17:03Z',
  ...overrides,
});

test('given two stored requests stored newest first and a ticket, when the Board is requested, then both requests are in To refine oldest first with their linked numbers, titles and created dates, the column total counts them, and no other column holds them', async () => {
  const app = appWith([
    frontierOf(
      [ticket({ number: 56 })],
      [
        request({ number: 164, title: 'Keep a sandboxed workload from reading forge state', url: 'https://github.com/rameezk/forge/issues/164', createdAt: '2026-10-03T12:35:20Z' }),
        request(),
      ],
    ),
  ]);

  const body = await (await app.request('/')).text();

  const columns = cardsByColumn(laneOf(body, 'forge'));
  assert.deepEqual(populated(columns), { 'to-refine': ['146', '164'], 'ready-for-agent': ['56'] });
  const header = columnHeaders(body).find((candidate) => candidate.includes('data-column-header="to-refine"')) ?? '';
  assert.equal(/data-column-total[^>]*>([^<]*)</.exec(header)?.[1], '2');
  const [first, second] = laneOf(body, 'forge').match(/<article[^>]*\sdata-ticket="(?:146|164)"[\s\S]*?<\/article>/g) ?? [];
  assert.match(first ?? '', /<a href="https:\/\/github.com\/rameezk\/forge\/issues\/146"[^>]*>#146<\/a>/);
  assert.match(textOf(first ?? ''), /Give each forge unit only the state directory access it needs/);
  assert.match(first ?? '', /<time datetime="2026-10-01T06:17:03Z"/);
  assert.match(second ?? '', /<time datetime="2026-10-03T12:35:20Z"/);
});

test('given a done dispatch with an open pull request and no running revision, when the Board is requested, then its In review card shows the PR link and no elapsed time', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true })])], (store) => {
    store.workloads.endDispatch(dispatched(store, 5), { state: 'done', pullRequest: pullRequest(105) }, '2026-09-30T09:00:00.000Z');
  });

  const card = cardOf(await (await app.request('/')).text(), 5);

  assert.match(textOf(card), /PR #105$/);
  assert.doesNotMatch(card, /data-elapsed-since|running/);
});

const startRevisionOn = (store: Store, ticketNumber: number, prNumber: number, startedAt = new Date().toISOString()): number => {
  const start = store.workloads.startRevision({ repository: 'forge', ...pullRequest(prNumber) }, [ticketNumber], `revision-${prNumber}`, startedAt, Number.POSITIVE_INFINITY);
  assert.ok('started' in start);
  return start.started;
};

const watchPullRequest = (store: Store, number: number, closes: number[]): void => {
  store.workloads.recordWatchedPullRequests('forge', [{ number, url: `https://github.com/rameezk/forge/pull/${number}`, closes, newestFeedbackAt: null, mergeable: 'MERGEABLE', headSha: 'head', draft: false, defaultSha: 'main0' }]);
};

const startResolutionClosing = (store: Store, prNumber: number, closes: number[], startedAt = new Date().toISOString()): number => {
  watchPullRequest(store, prNumber, closes);
  const start = store.workloads.startConflictResolution({ repository: 'forge', ...pullRequest(prNumber) }, closes, `resolution-${prNumber}`, startedAt, Number.POSITIVE_INFINITY, { headSha: 'head', defaultSha: 'default' });
  assert.ok('started' in start);
  return start.started;
};

const startResolutionOn = (store: Store, ticketNumber: number, prNumber: number, startedAt = new Date().toISOString()): number =>
  startResolutionClosing(store, prNumber, [ticketNumber], startedAt);

const inReview = (store: Store, number: number, startedAt = '2026-09-30T08:00:00.000Z'): void => {
  store.workloads.endDispatch(dispatched(store, number, startedAt), { state: 'done', pullRequest: pullRequest(100 + number) }, '2026-09-30T09:00:00.000Z');
};

const pillsOf = (card: string): string[] => [...card.matchAll(/<span[^>]*class="[^"]*rounded-full[^"]*"[^>]*>([^<]*)<\/span>/g)].map(([, text]) => text ?? '');

test('given a done dispatch with an open pull request and a live revision on it, when the Board is requested, then the ticket is in Running with a running pill linking to the revision run, an elapsed time from its harness start, a revision kind pill and its PR link', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true })])], (store) => {
    inReview(store, 5);
    store.runs.insertRun({ ...runOf(105), id: 'revision-105', startTime: '2026-09-30T10:00:00.000Z', harnessStartTime: '2026-09-30T10:05:00.000Z' });
    startRevisionOn(store, 5, 105);
  });

  const body = await (await app.request('/')).text();
  const card = cardOf(body, 5);

  assert.deepEqual(populated(cardsByColumn(laneOf(body, 'forge'))), { running: ['5'] });
  assert.match(card, /<a href="\/runs\/revision-105"[^>]*><span[^>]*>running<\/span><\/a>/);
  assert.match(card, /data-elapsed-since="2026-09-30T10:05:00.000Z"/);
  assert.equal(card.match(/data-elapsed-since/g)?.length, 1);
  assert.deepEqual(pillsOf(card), ['running', 'revision']);
  assert.match(card, /<a href="https:\/\/github.com\/rameezk\/forge\/pull\/105"[^>]*>PR #105<\/a>/);
  assert.doesNotMatch(card, /revising/);
});

test('given a done dispatch with an open pull request and a live conflict resolution on it, when the Board is requested, then the ticket is in Running with a running pill linking to the resolution run, an elapsed time, a conflict resolution kind pill and its PR link', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true })])], (store) => {
    inReview(store, 5);
    store.runs.insertRun({ ...runOf(105), id: 'resolution-105', startTime: '2026-09-30T10:00:00.000Z', harnessStartTime: '2026-09-30T10:07:00.000Z' });
    startResolutionOn(store, 5, 105);
  });

  const body = await (await app.request('/')).text();
  const card = cardOf(body, 5);

  assert.deepEqual(populated(cardsByColumn(laneOf(body, 'forge'))), { running: ['5'] });
  assert.match(card, /<a href="\/runs\/resolution-105"[^>]*><span[^>]*>running<\/span><\/a>/);
  assert.match(card, /data-elapsed-since="2026-09-30T10:07:00.000Z"/);
  assert.deepEqual(pillsOf(card), ['running', 'conflict resolution']);
  assert.match(card, /<a href="https:\/\/github.com\/rameezk\/forge\/pull\/105"[^>]*>PR #105<\/a>/);
});

test('given a running dispatch, when the Board is requested, then its card is in Running with a running pill, an elapsed time and a dispatch kind pill, and no pull request link', async () => {
  const app = appWith([frontierOf([ticket({ number: 4, forgeReady: true })])], (store) => {
    store.runs.insertRun({ ...runOf(4), harnessStartTime: '2026-09-30T08:03:00.000Z' });
    dispatched(store, 4, new Date().toISOString());
  });

  const body = await (await app.request('/')).text();
  const card = cardOf(body, 4);

  assert.deepEqual(populated(cardsByColumn(laneOf(body, 'forge'))), { running: ['4'] });
  assert.deepEqual(pillsOf(card), ['running', 'dispatch']);
  assert.match(card, /<a href="\/runs\/run-4"/);
  assert.match(card, /data-elapsed-since="2026-09-30T08:03:00.000Z"/);
  assert.doesNotMatch(card, /PR #/);
});

test('given a running dispatch whose ticket is blocked, one whose ticket is ready-for-human and a live revision on the open pull request of a ticket closed by hand, when the Board is requested, then all three are in Running and none is in Blocked, Ready for human or Done', async () => {
  const app = appWith([frontierOf(
    [ticket({ number: 4, forgeReady: true, blocked: true, blockedBy: [1] }), ticket({ number: 5, forgeReady: true, forHuman: true })],
    [],
    [closedTicket({ number: 6 })],
  )], (store) => {
    dispatched(store, 4, new Date().toISOString());
    dispatched(store, 5, new Date().toISOString());
    inReview(store, 6);
    startRevisionOn(store, 6, 106);
  });

  const body = await (await app.request('/')).text();

  assert.deepEqual(populated(cardsByColumn(laneOf(body, 'forge'))), { running: ['4', '5', '6'] });
  assert.deepEqual(pillsOf(cardOf(body, 6)), ['running', 'revision']);
});

test('given a done dispatch with an open pull request whose latest revision has ended and another whose latest conflict resolution has ended, when the Board is requested, then both are in In review with no running pill and no revising pill', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true }), ticket({ number: 6, forgeReady: true })])], (store) => {
    inReview(store, 5);
    inReview(store, 6);
    store.workloads.endRevision(startRevisionOn(store, 5, 105), 'done', new Date().toISOString());
    store.workloads.endConflictResolution(startResolutionOn(store, 6, 106), 'done', new Date().toISOString());
  });

  const body = await (await app.request('/')).text();

  assert.deepEqual(populated(cardsByColumn(laneOf(body, 'forge'))), { 'in-review': ['5', '6'] });
  for (const number of [5, 6]) assert.doesNotMatch(cardOf(body, number), /running|revising/);
});

test('given a revision still marked running whose last heartbeat is older than the liveness window, when the Board is requested, then its ticket is not in Running and the slot pill does not count it', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true })])], (store) => {
    inReview(store, 5);
    startRevisionOn(store, 5, 105, '2026-09-30T10:00:00.000Z');
  }, 4);

  const body = await (await app.request('/')).text();

  assert.deepEqual(populated(cardsByColumn(laneOf(body, 'forge'))), { 'in-review': ['5'] });
  assert.equal(textOf(runningLimit(body)).replace(/\s+/g, ' ').trim(), 'Running 0 / 4');
});

test('given a limit of 4 with one running dispatch, one live revision and one live conflict resolution across two repositories, when the Board is requested, then the Running column total reads 3 and the slot pill reads Running 3 / 4', async () => {
  const other = { repository: 'other', github: 'rameezk/other', polledAt: '2026-09-29T08:15:00.000Z', closed: [], requests: [], tickets: [ticket({ number: 9, forgeReady: true })] };
  const app = appWith([frontierOf([ticket({ number: 4, forgeReady: true }), ticket({ number: 5, forgeReady: true })]), other], (store) => {
    const now = new Date().toISOString();
    dispatched(store, 4, now);
    inReview(store, 5);
    startRevisionOn(store, 5, 105);
    const dispatch = store.workloads.startDispatch({ repository: 'other', number: 9, url: 'https://github.com/rameezk/other/issues/9' }, 'run-9', now, Number.POSITIVE_INFINITY, null);
    assert.ok('started' in dispatch);
    store.workloads.endDispatch(dispatch.started, { state: 'done', pullRequest: { number: 109, url: 'https://github.com/rameezk/other/pull/109' } }, now);
    const start = store.workloads.startConflictResolution({ repository: 'other', number: 109, url: 'https://github.com/rameezk/other/pull/109' }, [9], 'resolution-109', now, Number.POSITIVE_INFINITY, { headSha: 'head', defaultSha: 'default' });
    assert.ok('started' in start);
  }, 4);

  const body = await (await app.request('/')).text();
  const running = columnHeaders(body).find((header) => header.includes('data-column-header="running"')) ?? '';

  assert.equal(/data-column-total[^>]*>([^<]*)</.exec(running)?.[1], '3');
  assert.equal(textOf(runningLimit(body)).replace(/\s+/g, ' ').trim(), 'Running 3 / 4');
});

test('given a done dispatch with an open pull request whose latest revision did not start and no live workload, when the Board is requested, then the card is in In review with its Revision did not start line', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true })])], (store) => {
    inReview(store, 5);
    store.workloads.failRevisionStart(startRevisionOn(store, 5, 105), 'clone failed', new Date().toISOString());
  });

  const body = await (await app.request('/')).text();

  assert.deepEqual(populated(cardsByColumn(laneOf(body, 'forge'))), { 'in-review': ['5'] });
  assert.match(cardOf(body, 5), /data-revision-failed-start/);
  assert.match(textOf(cardOf(body, 5)), /Revision did not start/);
});

test('given the Board, when it is requested, then the slot pill tooltip reads Workloads running, out of the global limit', async () => {
  const header = runningLimit(await (await appWith([], () => {}, 2).request('/')).text());

  assert.match(header, /title="Workloads running, out of the global limit"/);
});

test('given a running dispatch whose run has no harness start time, when the Board is requested, then the Running card counts from the run start time', async () => {
  const app = appWith([frontierOf([ticket({ number: 4, forgeReady: true })])], (store) => {
    store.runs.insertRun({ ...runOf(4), startTime: '2026-09-30T08:01:00.000Z' });
    dispatched(store, 4, new Date().toISOString());
  });

  assert.match(cardOf(await (await app.request('/')).text(), 4), /data-elapsed-since="2026-09-30T08:01:00.000Z"/);
});

test('given a running dispatch whose run has a later harness start time, when the Board and the run page are requested, then both count from the same instant', async () => {
  const app = appWith([frontierOf([ticket({ number: 4, forgeReady: true })])], (store) => {
    store.runs.insertRun({ ...runOf(4), harnessStartTime: '2026-09-30T08:03:00.000Z' });
    dispatched(store, 4, new Date().toISOString());
  });

  const card = cardOf(await (await app.request('/')).text(), 4);
  const page = await (await app.request('/runs/run-4')).text();

  assert.match(card, /data-elapsed-since="2026-09-30T08:03:00.000Z"/);
  assert.match(page, /data-elapsed-since="2026-09-30T08:03:00.000Z"/);
});

const specLine = (card: string): string => card.match(/<p[^>]*\sdata-spec-line[^>]*>[\s\S]*?<\/p>/)?.[0] ?? '';

test('given a ticket whose parent is spec 440 and a ticket with no parent, when the Board is requested ungrouped, then the first card shows a linked spec line with the spec title and the second shows none', async () => {
  const app = appWith([
    frontierOf([
      ticket({ number: 1, parent: { number: 440, title: 'Board as the home page', url: 'https://github.com/rameezk/forge/issues/440' } }),
      ticket({ number: 2, parent: null }),
    ]),
  ]);

  const body = await (await app.request('/')).text();

  const line = specLine(cardOf(body, 1));
  assert.match(line, /<a href="https:\/\/github\.com\/rameezk\/forge\/issues\/440"[^>]*>#440<\/a>/);
  assert.equal(textOf(line), '↳ #440 Board as the home page');
  assert.match(openingTag(line), /title="#440 Board as the home page"/);
  assert.equal(specLine(cardOf(body, 2)), '');
});

const bands = (lane: string): string[] => lane.split(/(?=<div[^>]*\sdata-spec-band)/).slice(1);

const groupedFrontier = (): Seed[] => [
  frontierOf(
    [
      ticket({ number: 1, parent: { number: 455, title: 'Live dashboard updates', url: 'https://github.com/rameezk/forge/issues/455' } }),
      ticket({ number: 2, forgeReady: true, parent: { number: 440, title: 'Board as the home page', url: 'https://github.com/rameezk/forge/issues/440' } }),
      ticket({ number: 3, parent: { number: 440, title: 'Board as the home page', url: 'https://github.com/rameezk/forge/issues/440' } }),
      ticket({ number: 4, parent: null }),
    ],
    [{ number: 9, title: 'A request', url: 'https://github.com/rameezk/forge/issues/9', createdAt: '2026-09-28T10:07:58Z' }],
  ),
];

test('given tickets under specs 455 and 440 and a loose ticket and a request in one repository, when /?group=spec is requested, then the lane shows a 440 band, a 455 band and a No spec band last, each with its count, and no card shows a spec line', async () => {
  const app = appWith(groupedFrontier());

  const body = await (await app.request('/?group=spec')).text();
  const lane = laneOf(body, 'forge');
  const found = bands(lane);

  assert.deepEqual(found.map((band) => /data-spec-band="([^"]*)"/.exec(band)?.[1]), ['440', '455', 'none']);
  const heads = found.map((band) => textOf(band.match(/<header[^>]*\sdata-band-head[^>]*>[\s\S]*?<\/header>/)?.[0] ?? ''));
  assert.deepEqual(heads, ['#440 Board as the home page 2 tickets', '#455 Live dashboard updates 1 ticket', 'No spec 2 tickets']);
  assert.match(found[0] ?? '', /<a href="https:\/\/github\.com\/rameezk\/forge\/issues\/440"[^>]*>#440<\/a>/);
  assert.deepEqual((found[0] ?? '').match(/data-ticket="(\d+)"/g), ['data-ticket="3"', 'data-ticket="2"']);
  assert.match(found[2] ?? '', /data-ticket="9"/);
  assert.match(found[2] ?? '', /data-ticket="4"/);
  assert.equal((found[0]?.match(/data-column="/g) ?? []).length, 9);
  assert.doesNotMatch(lane, /data-spec-line/);
});

test('given tickets with a spec, when /?group=spec is requested, then a repository with no loose ticket shows no No spec band', async () => {
  const app = appWith([frontierOf([ticket({ number: 1 })])]);

  const lane = laneOf(await (await app.request('/?group=spec')).text(), 'forge');

  assert.deepEqual(bands(lane).map((band) => /data-spec-band="([^"]*)"/.exec(band)?.[1]), ['54']);
});

const groupControl = (body: string): string[][] =>
  [...(body.match(/<[^>]*\sdata-group-control[^>]*>[\s\S]*?<\/(?:div|nav)>/)?.[0] ?? '').matchAll(/<a href="([^"]*)"([^>]*)>([^<]*)<\/a>/g)].map(([, href, attributes, label]) => [href ?? '', label ?? '', /aria-current="true"/.test(attributes ?? '') ? 'current' : '']);

test('given the Board, when it is opened at / and at /?group=spec, then the grouping control marks None and Spec as current respectively and each option links to its URL', async () => {
  const app = appWith(groupedFrontier());

  const ungrouped = groupControl(await (await app.request('/')).text());
  const grouped = groupControl(await (await app.request('/?group=spec')).text());

  assert.deepEqual(ungrouped, [['/', 'None', 'current'], ['/?group=spec', 'Spec', '']]);
  assert.deepEqual(grouped, [['/', 'None', ''], ['/?group=spec', 'Spec', 'current']]);
  assert.doesNotMatch(await (await app.request('/?group=bogus')).text(), /data-spec-band/);
});

const cardLinkOf = (card: string): { href: string; label: string; sameTab: boolean } | undefined => {
  const tag = card.match(/<a\s[^>]*data-card-link[^>]*>/)?.[0];
  if (tag === undefined) return undefined;
  return {
    href: tag.match(/\shref="([^"]*)"/)?.[1] ?? '',
    label: tag.match(/\saria-label="([^"]*)"/)?.[1] ?? '',
    sameTab: !/\starget="_blank"/.test(tag),
  };
};

const issueLink = (number: number, label = `Open issue #${number}`) => ({ href: `https://github.com/rameezk/forge/issues/${number}`, label, sameTab: false });

const cardLinks = async (app: ReturnType<typeof appWith>, path: string, numbers: number[]) => {
  const body = await (await app.request(path)).text();
  return Object.fromEntries(numbers.map((number) => [number, cardLinkOf(cardOf(body, number))]));
};

const spec = (number: number) => ({ number, title: `Spec ${number}`, url: `https://github.com/rameezk/forge/issues/${number}` });

const named = (number: number, overrides: Partial<Ticket> = {}): Ticket =>
  ticket({ number, url: `https://github.com/rameezk/forge/issues/${number}`, parent: null, forgeReady: true, ...overrides });

const ticketsNamed = (numbers: number[]) => numbers.map((number) => named(number));

test('given a running dispatch whose run exists, a running revision, a running conflict resolution and a running dispatch whose run does not exist yet, when the Board is requested, then each Running card links to its own workload run in the same tab, or to the issue in a new tab when the run does not exist', async () => {
  const app = appWith([frontierOf(ticketsNamed([4, 5, 6, 7]))], (store) => {
    store.runs.insertRun(runOf(4));
    dispatched(store, 4, new Date().toISOString());
    inReview(store, 5);
    store.runs.insertRun({ ...runOf(105), id: 'revision-105' });
    startRevisionOn(store, 5, 105);
    inReview(store, 6);
    store.runs.insertRun({ ...runOf(106), id: 'resolution-106' });
    startResolutionOn(store, 6, 106);
    dispatched(store, 7, new Date().toISOString());
  });

  assert.deepEqual(await cardLinks(app, '/', [4, 5, 6, 7]), {
    4: { href: '/runs/run-4', label: 'Open run for #4', sameTab: true },
    5: { href: '/runs/revision-105', label: 'Open run for #5', sameTab: true },
    6: { href: '/runs/resolution-106', label: 'Open run for #6', sameTab: true },
    7: issueLink(7),
  });
});

const failedAttempt = (store: Store, number: number, runId: string | null, startedAt: string): void => {
  if (runId === null) {
    store.workloads.recordFailedStart(forgeTicket(number), 'harness missing', startedAt);
    return;
  }
  store.runs.insertRun({ ...runOf(number), id: runId });
  const start = store.workloads.startDispatch(forgeTicket(number), runId, startedAt, Number.POSITIVE_INFINITY, null);
  assert.ok('started' in start);
  store.workloads.endDispatch(start.started, { state: 'failed', reason: 'no-pull-request', detail: null }, startedAt);
};

const everyColumn = (): { tickets: Ticket[]; requests: RefinementRequest[]; closed: ClosedTicket[] } => ({
  requests: [request({ number: 20, url: 'https://github.com/rameezk/forge/issues/20' })],
  tickets: [
    ...ticketsNamed([10, 11, 12]),
    named(13, { blocked: true, blockedBy: [99] }),
    named(14, { forHuman: true }),
    named(15, { forgeReady: false }),
    named(16),
  ],
  closed: [closedTicket({ number: 18, url: 'https://github.com/rameezk/forge/issues/18' })],
});

const seedEveryColumn = (store: Store): void => {
  inReview(store, 10);
  const merged = dispatched(store, 18);
  store.workloads.endDispatch(merged, { state: 'done', pullRequest: pullRequest(118) }, '2026-09-30T09:00:00.000Z');
  store.workloads.recordPullRequest(merged, { state: 'merged', settledAt: '2026-09-30T10:00:00.000Z', rework: 0 });
  failedAttempt(store, 11, 'run-11a', '2026-09-30T06:00:00.000Z');
  failedAttempt(store, 11, 'run-11b', '2026-09-30T08:00:00.000Z');
  failedAttempt(store, 12, null, '2026-09-30T08:00:00.000Z');
};

const everyColumnDestinations = {
  10: { href: 'https://github.com/rameezk/forge/pull/110', label: 'Open PR #110', sameTab: false },
  11: { href: '/runs/run-11b', label: 'Open run for #11', sameTab: true },
  12: issueLink(12),
  13: issueLink(13),
  14: issueLink(14),
  15: issueLink(15),
  16: issueLink(16),
  18: issueLink(18),
  20: issueLink(20),
};

test('given a ticket in each column, a failed ticket with an earlier attempt and a failed start, when the Board is requested, then In review links to the pull request, Failed to the latest attempt run, a failed start to the issue and every other column to the issue', async () => {
  const { tickets, requests, closed } = everyColumn();
  const app = appWith([frontierOf(tickets, requests, closed)], seedEveryColumn);

  assert.deepEqual(await cardLinks(app, '/', Object.keys(everyColumnDestinations).map(Number)), everyColumnDestinations);
});

test('given the same tickets under two specs and loose, when /?group=spec is requested, then every card has the same destination as in the ungrouped Board', async () => {
  const { tickets, requests, closed } = everyColumn();
  const specs = [null, spec(440), spec(455)];
  const parented = tickets.map((entry, index) => ({ ...entry, parent: specs[index % 3] ?? null }));
  const app = appWith([frontierOf(parented, requests, closed)], seedEveryColumn);
  const numbers = Object.keys(everyColumnDestinations).map(Number);

  const body = await (await app.request('/?group=spec')).text();
  assert.match(body, /data-spec-band="440"/);
  assert.deepEqual(await cardLinks(app, '/?group=spec', numbers), everyColumnDestinations);
});

const readable = (html: string): string => textOf(html).replace(/\s+/g, ' ').trim();

interface LimitLine {
  text: string;
  breakdown: string | undefined;
  full: boolean;
}

const limitLine = (header: string): LimitLine | null => {
  const match = /<(?:span|button)\s[^>]*data-review-limit[^>]*>([^<]*)</.exec(header);
  if (match === null) return null;
  const tag = match[0];
  return { text: readable(match[1] ?? ''), breakdown: /\stitle="([^"]*)"/.exec(tag)?.[1], full: /\sdata-full/.test(tag) };
};

const stageHeaders = (body: string): string[] => body.match(/<div[^>]*\sdata-stage-header[\s\S]*?<\/div>/g) ?? [];

const inReviewStageHeader = (body: string): string => stageHeaders(body).find((header) => header.includes('>In review<')) ?? '';

const inReviewHeader = (body: string): string => columnHeaders(body).find((header) => header.includes('data-column-header="in-review"')) ?? '';

const columnTotal = (header: string): string | undefined => /data-column-total[^>]*>([^<]*)</.exec(header)?.[1];

const gaugeOf = async (open: number, running: number, limit: number | null, path = '/'): Promise<string> => {
  const waiting = Array.from({ length: open }, (_, index) => ticket({ number: index + 1 }));
  const app = appWith([frontierOf([ticket({ number: 90, forgeReady: true }), ...waiting])], (store) => {
    for (let number = 1; number <= open; number++) inReview(store, number);
    for (let number = 50; number < 50 + running; number++) dispatched(store, number, new Date().toISOString());
  }, 20, limit);
  return (await app.request(path)).text();
};

const BREAKDOWN_5 = 'Forge keeps at most 5 pull requests open or on the way.';

test('given no open dispatch pull requests, 1 running dispatch and a limit of 5, when the Board is requested, then the In review header shows Limit 5, no badge and no pips, a column count of 0 and the breakdown', async () => {
  const header = inReviewHeader(await gaugeOf(0, 1, 5));

  assert.deepEqual(limitLine(header), { text: 'Limit 5', full: false, breakdown: `${BREAKDOWN_5} Now: 0 open, 1 dispatch that will open one.` });
  assert.equal(columnTotal(header), '0');
  assert.doesNotMatch(header, /data-pip|data-review-running| \/ 5/);
});

test('given 3 open dispatch pull requests, 1 running dispatch and a limit of 5, when the Board is requested, then the In review header shows Limit 5 and a column count of 3, not flagged, and the unblocked ticket is not held', async () => {
  const body = await gaugeOf(3, 1, 5);
  const header = inReviewHeader(body);

  assert.deepEqual(limitLine(header), { text: 'Limit 5', full: false, breakdown: `${BREAKDOWN_5} Now: 3 open, 1 dispatch that will open one.` });
  assert.equal(columnTotal(header), '3');
  assert.doesNotMatch(header, /text-warning/);
  assert.doesNotMatch(cardOf(body, 90), /data-held/);
});

test('given 5 open dispatch pull requests, nothing running and a limit of 5, when the Board is requested, then the In review header shows the warning badge, a column count of 5 and a breakdown that ends with when new dispatches start again', async () => {
  const header = inReviewHeader(await gaugeOf(5, 0, 5));

  assert.deepEqual(limitLine(header), {
    text: 'Limit reached · new dispatches wait',
    full: true,
    breakdown: `${BREAKDOWN_5} Now: 5 open, 0 dispatches that will open one. New dispatches start again when you merge or close one.`,
  });
  assert.equal(columnTotal(header), '5');
  assert.match(header, /text-warning/);
});

test('given 4 open dispatch pull requests, 1 running dispatch and a limit of 5, when the Board is requested, then the badge names the pull request on the way and the column count is 4', async () => {
  const header = inReviewHeader(await gaugeOf(4, 1, 5));

  assert.equal(limitLine(header)?.text, 'Limit reached · 1 PR on the way · new dispatches wait');
  assert.equal(limitLine(header)?.full, true);
  assert.equal(columnTotal(header), '4');
});

test('given 3 open dispatch pull requests, 2 running dispatches and a limit of 5, when the Board is requested, then the badge and the breakdown use plurals', async () => {
  const line = limitLine(inReviewHeader(await gaugeOf(3, 2, 5)));

  assert.equal(line?.text, 'Limit reached · 2 PRs on the way · new dispatches wait');
  assert.match(line?.breakdown ?? '', /Now: 3 open, 2 dispatches that will open one\./);
});

test('given a limit of 1 with 1 open dispatch pull request, when the Board is requested, then the breakdown says 1 pull request', async () => {
  assert.match(limitLine(inReviewHeader(await gaugeOf(1, 0, 1)))?.breakdown ?? '', /^Forge keeps at most 1 pull request open or on the way\. Now: 1 open, /);
});

test('given 5 open dispatch pull requests, a running revision on one and a limit of 5, when the Board is requested, then the badge does not name a pull request on the way', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true })])], (store) => {
    for (let number = 1; number <= 5; number++) inReview(store, number);
    startRevisionOn(store, 5, 105);
  }, 20, 5);

  const line = limitLine(inReviewHeader(await (await app.request('/')).text()));

  assert.equal(line?.text, 'Limit reached · new dispatches wait');
  assert.match(line?.breakdown ?? '', /Now: 5 open, 0 dispatches that will open one\./);
});

test('given no review limit, when the Board is requested, then neither the In review column header nor its stage header shows a limit line or badge', async () => {
  const body = await gaugeOf(10, 1, null);

  assert.equal(limitLine(inReviewHeader(body)), null);
  assert.equal(limitLine(inReviewStageHeader(body)), null);
});

test('given no open dispatch pull requests, 1 running dispatch and a limit of 5, when the Board is requested, then the In review stage header shows no limit line, no badge and no pips', async () => {
  const stage = inReviewStageHeader(await gaugeOf(0, 1, 5));

  assert.notEqual(stage, '');
  assert.equal(limitLine(stage), null);
  assert.doesNotMatch(stage, /data-pip|Limit/);
});

test('given 4 open dispatch pull requests, 1 running dispatch and a limit of 5, when the Board is requested, then the stage header shows a short Limit reached badge that opens the breakdown', async () => {
  const stage = inReviewStageHeader(await gaugeOf(4, 1, 5));
  const target = /<button[^>]*data-review-limit[^>]*\spopovertarget="([^"]*)"/.exec(stage)?.[1];

  assert.equal(limitLine(stage)?.text, 'Limit reached');
  assert.equal(limitLine(stage)?.full, true);
  assert.ok(target, 'the badge is a button that targets a popover');
  assert.match(stage, new RegExp(`<[^>]*\\spopover[^>]*\\sid="${target}"[^>]*>${BREAKDOWN_5} Now: 4 open, 1 dispatch that will open one\\. New dispatches start again when you merge or close one\\.<`));
});

test('given 4 open dispatch pull requests, 1 running dispatch, a limit of 5 and the Board grouped by spec, when the Board is requested, then the compact stage header shows the same badge and every popover id is unique', async () => {
  const body = await gaugeOf(4, 1, 5, '/?group=spec');
  const ids = [...body.matchAll(/\spopovertarget="([^"]*)"/g)].map(([, id]) => id);

  assert.equal(limitLine(inReviewStageHeader(body))?.text, 'Limit reached');
  assert.equal(new Set(ids).size, ids.length);
});

test('given the review limit is reached, an unblocked forge:ready ticket and a blocked forge:ready ticket, when the Board is requested, then the In review header is flagged, the unblocked ticket is held and the queued ticket keeps its Blocked look', async () => {
  const app = appWith([frontierOf([ticket({ number: 9, forgeReady: true }), ticket({ number: 10, forgeReady: true, blocked: true, blockedBy: [9] })])], (store) => {
    for (const number of [1, 2, 3]) inReview(store, number);
    dispatched(store, 4, new Date().toISOString());
    dispatched(store, 5, new Date().toISOString());
  }, 5, 5);

  const body = await (await app.request('/')).text();
  const line = limitLine(inReviewHeader(body));
  const held = cardOf(body, 9);
  const queued = cardOf(body, 10);

  assert.equal(line?.text, 'Limit reached · 2 PRs on the way · new dispatches wait');
  assert.equal(line?.full, true);
  assert.deepEqual(pillsOf(held), ['held: review limit']);
  assert.match(held, /data-held/);
  assert.doesNotMatch(queued, /data-held/);
  assert.deepEqual(pillsOf(queued), ['queued']);
  assert.deepEqual(populated(cardsByColumn(laneOf(body, 'forge'))).blocked, ['10']);
});

test('given a null review limit and 10 open pull requests, when the Board is requested, then the In review header shows only the count and nothing is held', async () => {
  const app = appWith([frontierOf([ticket({ number: 9, forgeReady: true })])], (store) => {
    for (let number = 1; number <= 10; number++) inReview(store, number);
  }, 5, null);

  const body = await (await app.request('/')).text();

  assert.equal(limitLine(inReviewHeader(body)), null);
  assert.doesNotMatch(cardOf(body, 9), /data-held/);
});

test('given the review limit is reached and a forge:ready ticket whose earlier dispatch failed, when the Board is requested, then it stays in Failed and is held', async () => {
  const app = appWith([frontierOf([ticket({ number: 9, forgeReady: true })])], (store) => {
    for (const number of [1, 2, 3, 4, 5]) inReview(store, number);
    failedAttempt(store, 9, null, '2026-09-30T08:00:00.000Z');
  }, 5, 5);

  const body = await (await app.request('/')).text();

  assert.deepEqual(populated(cardsByColumn(laneOf(body, 'forge'))).failed, ['9']);
  assert.deepEqual(pillsOf(cardOf(body, 9)).filter((pill) => pill === 'held: review limit'), ['held: review limit']);
});

test('given a repository whose default-branch rules failed at the last sync and one that passed, when the Board is requested, then the failing lane names each failing rule and says no new work starts, and the passing lane shows nothing', async () => {
  const app = appWith([
    { ...frontierOf([ticket({ number: 1 })]), branchRules: ['GitHub Actions can approve pull requests', 'its default branch does not require an approving review'] },
    { repository: 'dotfiles', github: 'rameezk/dotfiles', polledAt: '2026-09-29T08:10:00.000Z', closed: [], requests: [], tickets: [ticket({ number: 3, url: 'https://github.com/rameezk/dotfiles/issues/3', parent: null })], branchRules: [] } as Seed,
  ]);

  const body = await (await app.request('/')).text();
  const [dotfiles, forge] = sections(body);
  assert.ok(dotfiles && forge);

  assert.doesNotMatch(dotfiles, /data-branch-rules/);
  const callout = /<p[^>]*\sdata-branch-rules[^>]*>([\s\S]*?)<\/p>/.exec(forge)?.[1] ?? '';
  assert.match(callout, /No new work starts here/);
  assert.match(callout, /GitHub Actions can approve pull requests/);
  assert.match(callout, /its default branch does not require an approving review/);
});

const watchHead = (store: Store, number: number, headSha: string): void => {
  store.workloads.recordWatchedPullRequests('forge', [{ number, url: `https://github.com/rameezk/forge/pull/${number}`, closes: [], newestFeedbackAt: null, mergeable: 'MERGEABLE', headSha, draft: false, defaultSha: 'main0' }]);
};

const gradeOf = (number: number, headSha: string, overrides: Partial<RiskGrade> = {}): RiskGrade => ({
  repository: 'forge',
  number,
  headSha,
  fingerprint: 'typesafe/jev-1.13:abc',
  model: 'typesafe/jev-1.13',
  probabilities: { trivial: 0.02, low: 0.1, moderate: 0.05, high: 0.83 },
  score: 0.9,
  confidence: 0.83,
  level: 'high',
  uncertain: false,
  costUsd: 0.25,
  gradedAt: '2026-09-30T09:30:00.000Z',
  ...overrides,
});

const doneMerged = (store: Store, number: number, outcome: 'merged' | 'auto-merged'): void => {
  const id = dispatched(store, number);
  store.workloads.endDispatch(id, { state: 'done', pullRequest: pullRequest(100 + number) }, '2026-09-28T09:00:00.000Z');
  store.workloads.recordPullRequest(id, { state: 'merged', settledAt: '2026-09-28T10:00:00.000Z', rework: 0 });
  watchHead(store, 100 + number, 'head1');
  store.grades.recordRiskGrade(gradeOf(100 + number, 'head1', { level: 'low' }));
  store.grades.settleRiskGrade({ repository: 'forge', number: 100 + number, headSha: 'head1' }, outcome, '2026-09-28T10:00:00.000Z');
};

test('given a done ticket whose pull request auto-merged and another merged by a person, when the Board is requested, then only the first carries an auto-merged pill', async () => {
  const app = appWith([frontierOf([], [], [closedTicket({ number: 10 }), closedTicket({ number: 11 })])], (store) => {
    doneMerged(store, 10, 'auto-merged');
    doneMerged(store, 11, 'merged');
  }, undefined, undefined, GRADING);

  const body = await (await app.request('/')).text();

  assert.match(cardOf(body, 10), /<span[^>]*data-auto-merged[^>]*>\s*auto-merged\s*<\/span>/);
  assert.match(cardOf(body, 10), /data-merged/);
  assert.doesNotMatch(cardOf(body, 11), /data-auto-merged/);
});

test('given a ticket in review whose pull request is held and another whose is not, when the Board is requested, then only the first carries a held pill', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true }), ticket({ number: 6, forgeReady: true })])], (store) => {
    inReview(store, 5);
    inReview(store, 6);
    store.recordHold('forge', 105, true);
  }, undefined, undefined, GRADING);

  const body = await (await app.request('/')).text();

  assert.match(cardOf(body, 5), /<span[^>]*data-hold[^>]*>\s*held\s*<\/span>/);
  assert.doesNotMatch(cardOf(body, 6), /data-hold/);
});

test('given a ticket whose pull request is sampled and another whose is not, when the Board is requested, then only the first card in review carries a sampled pill', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true }), ticket({ number: 6, forgeReady: true })])], (store) => {
    for (const number of [5, 6]) {
      inReview(store, number);
      watchHead(store, 100 + number, 'head1');
      store.grades.recordRiskGrade(gradeOf(100 + number, 'head1', { level: 'low' }));
    }
    drawSample(store, 'forge', 105, () => true, '2026-09-30T09:30:00.000Z');
    drawSample(store, 'forge', 106, () => false, '2026-09-30T09:30:00.000Z');
  }, undefined, undefined, GRADING);

  const body = await (await app.request('/')).text();

  assert.match(cardOf(body, 5), /<span[^>]*data-sampled[^>]*>\s*sampled\s*<\/span>/);
  assert.doesNotMatch(cardOf(body, 6), /data-sampled/);
});

const gatedBoard = (gates: { key: GateKey; detail: string }[], verdictHead = 'head1', optedIn = ['forge']) =>
  appWith([frontierOf([ticket({ number: 5, forgeReady: true })])], (store) => {
    inReview(store, 5);
    watchHead(store, 105, 'head1');
    store.grades.recordRiskGrade(gradeOf(105, 'head1', { level: 'low' }));
    store.recordAutoMergeVerdict('forge', 105, verdictHead, { verdict: { kind: 'waits', gates }, conclusion: 'neutral', checkRunId: 7 });
  }, undefined, undefined, GRADING, { autoMergeRepositories: optedIn });

const gatePills = (card: string): { label: string; title: string }[] =>
  [...card.matchAll(/<span[^>]*data-gate="([^"]+)"[^>]*title="([^"]*)"[^>]*>\s*([^<]*?)\s*<\/span>/g)].map((match) => ({ label: match[3]!, title: match[2]! }));

test('given an in-review candidate whose stored verdict names a protected path, when the Board is requested, then its card shows a protected path pill whose title names the path', async () => {
  const path = 'runtime/packages/runner/src/config.ts';
  const body = await (await gatedBoard([{ key: 'protected-path', detail: `it touches the protected path \`${path}\`` }]).request('/')).text();

  const pills = gatePills(cardOf(body, 5));

  assert.deepEqual(pills.map(({ label }) => label), ['protected path']);
  assert.ok(pills[0]!.title.includes(path));
  assert.match(cardOf(body, 5), /<span[^>]*data-gate="protected-path"[^>]*class="[^"]*text-muted[^"]*ring-line/);
});

test('given a candidate held back by a protected path and the size cap, when the Board is requested, then its card shows a pill for each with its detail', async () => {
  const body = await (await gatedBoard([
    { key: 'protected-path', detail: 'it touches the protected path `a.ts`' },
    { key: 'size', detail: 'it changes 900 lines, over the cap of 400' },
  ]).request('/')).text();

  assert.deepEqual(gatePills(cardOf(body, 5)), [
    { label: 'protected path', title: 'it touches the protected path `a.ts`' },
    { label: 'size', title: 'it changes 900 lines, over the cap of 400' },
  ]);
});

test('given every gate key, when the Board is requested, then each pill carries its short gate name', async () => {
  const keys = ['draft', 'working', 'mergeability', 'checks-failing', 'checks-pending', 'feedback', 'protected-path', 'too-many-files', 'not-seen', 'size'] as const;
  const body = await (await gatedBoard(keys.map((key) => ({ key, detail: `detail of ${key}` }))).request('/')).text();

  assert.deepEqual(gatePills(cardOf(body, 5)).map(({ label }) => label), ['draft', 'working', 'mergeability', 'checks failing', 'checks pending', 'feedback', 'protected path', 'too many files', 'not seen by Jev', 'size']);
});

test('given a stored verdict that names no gate, when the Board is requested, then its card shows no gate pill', async () => {
  const body = await (await gatedBoard([]).request('/')).text();

  assert.doesNotMatch(cardOf(body, 5), /data-gate/);
});

test('given a pull request graded moderate with no verdict, when the Board is requested, then its card shows no gate pill', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true })])], (store) => {
    inReview(store, 5);
    watchHead(store, 105, 'head1');
    store.grades.recordRiskGrade(gradeOf(105, 'head1', { level: 'moderate' }));
  }, undefined, undefined, GRADING);

  assert.doesNotMatch(cardOf(await (await app.request('/')).text(), 5), /data-gate/);
});

test('given a stored verdict in a repository that has not opted in to auto-merge, when the Board is requested, then its card shows no gate pill', async () => {
  const body = await (await gatedBoard([{ key: 'size', detail: 'too big' }], 'head1', []).request('/')).text();

  assert.doesNotMatch(cardOf(body, 5), /data-gate/);
});

test('given a verdict stored for a head the pull request moved past, when the Board is requested, then its card shows no gate pill', async () => {
  const body = await (await gatedBoard([{ key: 'size', detail: 'too big' }], 'old-head').request('/')).text();

  assert.doesNotMatch(cardOf(body, 5), /data-gate/);
});

const settleHistory = (store: Store, held: number, failed: number): void => {
  for (let index = 0; index < held + failed; index += 1) {
    const number = 900 + index;
    store.grades.recordRiskGrade(gradeOf(number, `old-${number}`, { level: 'low', gradedAt: '2026-09-29T09:00:00.000Z' }));
    store.grades.settleRiskGrade(
      { repository: 'forge', number, headSha: `old-${number}` },
      index < failed ? 'closed' : 'merged',
      `2026-09-29T10:${String(index).padStart(2, '0')}:00.000Z`,
    );
  }
};

const pausedBoard = (held: number, failed: number, optedIn = ['forge'], announced = true) =>
  appWith([frontierOf([ticket({ number: 5, forgeReady: true }), ticket({ number: 6, forgeReady: true }), ticket({ number: 7, forgeReady: true })])], (store) => {
    settleHistory(store, held, failed);
    for (const number of [5, 6, 7]) {
      inReview(store, number);
      store.grades.recordRiskGrade(gradeOf(100 + number, 'head1', { level: number === 7 ? 'moderate' : 'low' }));
    }
    store.workloads.recordWatchedPullRequests('forge', [105, 106, 107].map((number) => ({ number, url: `https://github.com/rameezk/forge/pull/${number}`, closes: [], newestFeedbackAt: null, mergeable: 'MERGEABLE' as const, headSha: 'head1', draft: false, defaultSha: 'main0' })));
    drawSample(store, 'forge', 106, () => true, '2026-09-30T09:30:00.000Z');
    if (announced) store.markSampleAnnounced('forge', 106);
  }, undefined, undefined, GRADING, { autoMergeRepositories: optedIn });

test('given a pause, when the Board is requested, then an eligible card in review carries a paused pill, and a sampled one and a moderate one do not', async () => {
  const body = await (await pausedBoard(17, 3).request('/')).text();

  assert.match(cardOf(body, 5), /<span[^>]*data-paused[^>]*>\s*paused\s*<\/span>/);
  assert.doesNotMatch(cardOf(body, 6), /data-paused/);
  assert.match(cardOf(body, 6), /data-sampled/);
  assert.doesNotMatch(cardOf(body, 7), /data-paused/);
});

test('given a pause and a pull request that is sampled but not yet announced, when the Board is requested, then its card carries a sampled pill and no paused pill', async () => {
  const app = pausedBoard(17, 3, ['forge'], false);

  const body = await (await app.request('/')).text();

  assert.match(cardOf(body, 6), /data-sampled/);
  assert.doesNotMatch(cardOf(body, 6), /data-paused/);
});

test('given a record above the bar, or a repository that has not opted in, when the Board is requested, then no card carries a paused pill', async () => {
  for (const app of [pausedBoard(19, 1), pausedBoard(17, 3, [])]) {
    assert.doesNotMatch(await (await app.request('/')).text(), /data-paused/);
  }
});

const riskOf = (card: string): string => card.match(/<[^>]*\sdata-risk=[^>]*>[\s\S]*?<\/span>(?:\s*<span[^>]*data-risk-alternative[^>]*>[\s\S]*?<\/span>)?/)?.[0] ?? '';

const GRADING = ['forge'];

test('given a pull request in review whose current head is graded high at 83% confidence, when the Board is requested, then its card shows a high badge with 83%', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true })])], (store) => {
    inReview(store, 5);
    watchHead(store, 105, 'head1');
    store.grades.recordRiskGrade(gradeOf(105, 'head1'));
  }, undefined, undefined, GRADING);

  const risk = riskOf(cardOf(await (await app.request('/')).text(), 5));

  assert.match(risk, /data-risk="high"/);
  assert.equal(readable(risk), 'high 83%');
  assert.doesNotMatch(risk, /data-risk-uncertain/);
});

test('given a current uncertain grade of low with high as runner-up, when the Board is requested, then the badge shows low with high as the possible alternative', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true })])], (store) => {
    inReview(store, 5);
    watchHead(store, 105, 'head1');
    store.grades.recordRiskGrade(gradeOf(105, 'head1', { probabilities: { trivial: 0.05, low: 0.5, moderate: 0.1, high: 0.35 }, confidence: 0.41, level: 'low', uncertain: true }));
  }, undefined, undefined, GRADING);

  const risk = riskOf(cardOf(await (await app.request('/')).text(), 5));

  assert.match(risk, /data-risk="low"/);
  assert.match(risk, /data-risk-uncertain/);
  assert.match(risk, /title="Risk low, confidence 41%, uncertain, possibly high"/);
  assert.equal(readable(risk), 'low 41% or high');
});

test('given a pull request in review whose current head has no grade, or only a grade of an earlier head, when the Board is requested, then its card shows grading and no level', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true }), ticket({ number: 6, forgeReady: true })])], (store) => {
    inReview(store, 5);
    inReview(store, 6);
    watchHead(store, 105, 'head2');
    store.grades.recordRiskGrade(gradeOf(105, 'head1'));
  }, undefined, undefined, GRADING);

  const body = await (await app.request('/')).text();

  for (const number of [5, 6]) {
    const risk = riskOf(cardOf(body, number));
    assert.match(risk, /data-risk="grading"/);
    assert.equal(readable(risk), 'grading');
  }
});

test('given a repository with grading off, when the Board is requested, then its in-review card has no risk badge even when it holds a grade', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true })])], (store) => {
    inReview(store, 5);
    watchHead(store, 105, 'head1');
    store.grades.recordRiskGrade(gradeOf(105, 'head1'));
  });

  const body = await (await app.request('/')).text();

  assert.doesNotMatch(cardOf(body, 5), /data-risk/);
});

test('given grades recorded with costs, when the Board is requested, then it shows no grading cost line and the Risk tab cost card shows their sum', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true })])], (store) => {
    inReview(store, 5);
    watchHead(store, 105, 'head1');
    store.grades.recordRiskGrade(gradeOf(105, 'head0', { costUsd: 0.002 }));
    store.grades.recordRiskGrade(gradeOf(105, 'head1', { costUsd: 0.004 }));
  }, undefined, undefined, GRADING);

  const body = await (await app.request('/')).text();
  const risk = await (await app.request('/insights?tab=risk')).text();

  assert.doesNotMatch(body, /data-grading-cost|Grading cost/);
  assert.match(readable(/<[^>]*data-metric="cost-total"[^>]*>[\s\S]*?<\/p>/.exec(risk)?.[0] ?? ''), /\$0\.006/);
});

const attemptOf = (number: number, headSha: string, category: GradingFailure, message: string, attemptedAt = '2026-10-01T10:00:00.000Z'): GradingAttempt => ({
  repository: 'forge',
  number,
  headSha,
  attemptedAt,
  category,
  message,
});

test('given heads whose grading produced no level, when the Board is requested, then each card says why there is no grade', async () => {
  const cases: [GradingFailure, string, string, string][] = [
    ['temporary', 'OpenRouter answered 503', 'temporary', 'not graded temporary, retrying'],
    ['setup', 'OpenRouter rejected the key', 'setup', 'not graded setup, retrying'],
    ['bug', 'OpenRouter rejected the request with 400', 'bug', 'not graded bug, retrying'],
    ['declined', 'Jev declined to answer', 'declined', 'declined'],
    ['too-large', "the input does not fit Jev's context window", 'too-large', 'too large'],
  ];
  for (const [category, message, state, text] of cases) {
    const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true })])], (store) => {
      inReview(store, 5);
      watchHead(store, 105, 'head1');
      store.grades.recordGradingAttempt(attemptOf(105, 'head1', category, message));
    }, undefined, undefined, GRADING);

    const card = cardOf(await (await app.request('/')).text(), 5);
    const risk = riskOf(card);

    assert.match(risk, new RegExp(`data-risk="${state}"`), category);
    assert.equal(readable(/<p[^>]*>(?:(?!<\/p>)[\s\S])*data-risk=[\s\S]*?<\/p>/.exec(card)?.[0] ?? ''), text, category);
    assert.match(risk, new RegExp(`title="Not graded: ${message.replace(/[()]/g, '\\$&').replace(/'/g, '&#39;')}`), category);
  }
});

test('given a failure on an earlier head only, when the Board is requested, then the card of the new head shows grading', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true })])], (store) => {
    inReview(store, 5);
    watchHead(store, 105, 'head2');
    store.grades.recordGradingAttempt(attemptOf(105, 'head1', 'declined', 'Jev declined to answer'));
  }, undefined, undefined, GRADING);

  assert.match(riskOf(cardOf(await (await app.request('/')).text(), 5)), /data-risk="grading"/);
});

const runningCards = (body: string): string[] => {
  const column = body.match(/<div[^>]*\sdata-column="running"[\s\S]*?(?=<div[^>]*\sdata-column="in-review")/)?.[0] ?? '';
  return column.match(/<article[^>]*\sdata-ticket="[^"]*"[\s\S]*?<\/article>/g) ?? [];
};

const runningNumbers = (body: string): string[] => runningCards(body).map((card) => /data-ticket="([^"]*)"/.exec(card)?.[1] ?? '');

const runningLimitOf = (body: string): string => textOf(/<span[^>]*data-running-limit[\s\S]*?<\/span>/.exec(body)?.[0] ?? '');

test('given a ticket whose dispatch failed leaving an open pull request with a live conflict resolution, when the Board is requested, then the ticket is in Running with a conflict resolution card, not in Failed, and the running count equals the Running cards', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true })])], (store) => {
    store.workloads.endDispatch(dispatched(store, 5), { state: 'failed', reason: 'no-pull-request', detail: null }, '2026-09-30T09:00:00.000Z');
    startResolutionClosing(store, 105, [5]);
  });

  const body = await (await app.request('/')).text();

  assert.deepEqual(populated(cardsByColumn(laneOf(body, 'forge'))), { running: ['5'] });
  assert.deepEqual(pillsOf(cardOf(body, 5)), ['running', 'conflict resolution']);
  assert.equal(runningLimitOf(body), 'Running 1 / 1');
});

test('given a done dispatch that opened a pull request, a newer dispatch that failed to start and a live revision on the pull request, when the Board is requested, then the ticket is in Running with a revision card', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true })])], (store) => {
    inReview(store, 5);
    store.workloads.recordFailedStart(forgeTicket(5), 'clone failed', '2026-09-30T09:30:00.000Z');
    startRevisionOn(store, 5, 105);
  });

  const body = await (await app.request('/')).text();

  assert.deepEqual(populated(cardsByColumn(laneOf(body, 'forge'))), { running: ['5'] });
  assert.deepEqual(pillsOf(cardOf(body, 5)), ['running', 'revision']);
});

test('given a ticket with a live revision on one pull request and a live conflict resolution on another, when the Board is requested, then Running holds two cards for the ticket, each with its own kind, timer and run link, and the ticket is in no other column', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true })])], (store) => {
    inReview(store, 5);
    const now = new Date().toISOString();
    store.runs.insertRun({ ...runOf(105), id: 'revision-105', harnessStartTime: '2026-09-30T10:05:00.000Z' });
    store.runs.insertRun({ ...runOf(106), id: 'resolution-106', harnessStartTime: '2026-09-30T10:07:00.000Z' });
    startRevisionOn(store, 5, 105, new Date(Date.parse(now) - 60_000).toISOString());
    startResolutionOn(store, 5, 106, now);
  });

  const body = await (await app.request('/')).text();
  const cards = runningCards(body);

  assert.deepEqual(populated(cardsByColumn(laneOf(body, 'forge'))), { running: ['5', '5'] });
  assert.deepEqual(cards.map(pillsOf), [['running', 'revision'], ['running', 'conflict resolution']]);
  assert.deepEqual(cards.map((card) => /data-elapsed-since="([^"]*)"/.exec(card)?.[1]), ['2026-09-30T10:05:00.000Z', '2026-09-30T10:07:00.000Z']);
  assert.deepEqual(cards.map((card) => /<a href="(\/runs\/[^"]*)"/.exec(card)?.[1]), ['/runs/revision-105', '/runs/resolution-106']);
  assert.equal(runningLimitOf(body), 'Running 2 / 1');
});

test('given a live conflict resolution on a pull request closing two tickets on the Board, one open and one recently closed, when the Board is requested, then Running holds one card for each ticket', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true })], [], [closedTicket({ number: 6 })])], (store) => {
    startResolutionClosing(store, 105, [5, 6]);
  });

  const body = await (await app.request('/')).text();

  assert.deepEqual(populated(cardsByColumn(laneOf(body, 'forge'))), { running: ['5', '6'] });
});

test('given a live conflict resolution on a pull request closing no ticket on the Board, when the Board is requested ungrouped and grouped by spec, then Running holds a card for the pull request in its lane, titled with its number, linking to it, and in the No spec band when grouped', async () => {
  const app = appWith([frontierOf([ticket({ number: 5 })])], (store) => {
    store.runs.insertRun({ ...runOf(120), id: 'resolution-120', harnessStartTime: '2026-09-30T10:07:00.000Z' });
    startResolutionClosing(store, 120, [77]);
  });

  const body = await (await app.request('/')).text();
  const card = runningCards(body)[0] ?? '';

  assert.deepEqual(populated(cardsByColumn(laneOf(body, 'forge'))), { 'ready-for-agent': ['5'], running: ['120'] });
  assert.match(card, /<a href="https:\/\/github.com\/rameezk\/forge\/pull\/120"[^>]*>#120<\/a>/);
  assert.match(card, /<a href="\/runs\/resolution-120"[^>]*><span[^>]*>running<\/span><\/a>/);
  assert.match(card, /data-elapsed-since="2026-09-30T10:07:00.000Z"/);
  assert.deepEqual(pillsOf(card), ['running', 'conflict resolution']);
  assert.doesNotMatch(card, /data-spec-line|PR #120/);
  assert.equal(runningLimitOf(body), 'Running 1 / 1');

  const grouped = await (await app.request('/?group=spec')).text();
  const none = grouped.match(/<div data-spec-band="none"[\s\S]*$/)?.[0] ?? '';
  assert.deepEqual(runningNumbers(none), ['120']);
});

test('given a live dispatch for a ticket that is no longer on the Board, when the Board is requested, then Running holds a card for the issue in its lane, titled with its number and linking to it', async () => {
  const app = appWith([frontierOf([ticket({ number: 5 })])], (store) => {
    store.runs.insertRun({ ...runOf(9), harnessStartTime: '2026-09-30T08:03:00.000Z' });
    dispatched(store, 9, new Date().toISOString());
  });

  const body = await (await app.request('/')).text();
  const card = cardOf(body, 9);

  assert.deepEqual(populated(cardsByColumn(laneOf(body, 'forge'))), { 'ready-for-agent': ['5'], running: ['9'] });
  assert.match(card, /<a href="https:\/\/github.com\/rameezk\/forge\/issues\/9"[^>]*>#9<\/a>/);
  assert.deepEqual(pillsOf(card), ['running', 'dispatch']);
  assert.match(card, /<a href="\/runs\/run-9"/);
  assert.equal(runningLimitOf(body), 'Running 1 / 1');
});

test('given a live workload on an older ticket that started after a live workload on a newer ticket, when the Board is requested, then Running lists the newer ticket first', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true }), ticket({ number: 6, forgeReady: true })])], (store) => {
    const later = new Date().toISOString();
    const earlier = new Date(Date.parse(later) - 60_000).toISOString();
    dispatched(store, 5, later);
    dispatched(store, 6, earlier);
  });

  assert.deepEqual(runningNumbers(await (await app.request('/')).text()), ['6', '5']);
});

test('given a live diagnosis workload, when the Board is requested, then Running holds no card for it and the running count does not include it', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true })])], (store) => {
    store.runs.insertRun({ ...runOf(5), status: 'error' });
    store.diagnoses.startDiagnosis('run-5', 'diagnosis-5', new Date().toISOString());
  });

  const body = await (await app.request('/')).text();

  assert.deepEqual(runningNumbers(body), []);
  assert.equal(runningLimitOf(body), 'Running 0 / 1');
});

test('given a ticket whose only live workload ends, when the Board is requested, then the ticket is in its usual column and not in Running', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true })])], (store) => {
    store.workloads.endDispatch(dispatched(store, 5), { state: 'failed', reason: 'no-pull-request', detail: null }, '2026-09-30T09:00:00.000Z');
    store.workloads.endConflictResolution(startResolutionClosing(store, 105, [5]), 'done', new Date().toISOString());
  });

  assert.deepEqual(populated(cardsByColumn(laneOf(await (await app.request('/')).text(), 'forge'))), { failed: ['5'] });
});

const urgencyOf = (number: number, level: UrgencyLevel, overrides: Partial<UrgencyGrade> = {}): UrgencyGrade => ({
  repository: 'forge',
  number,
  version: `v${number}`,
  fingerprint: 'typesafe/jev-1.13:def',
  model: 'typesafe/jev-1.13',
  probabilities: { critical: 0.05, high: 0.05, normal: 0.05, low: 0.05, [level]: 0.85 },
  score: 0.5,
  confidence: 0.85,
  level,
  uncertain: false,
  costUsd: 0.01,
  gradedAt: '2026-10-02T09:00:00.000Z',
  ...overrides,
});

const urgencyBadgeOf = (card: string): string => /<p[^>]*>(?:(?!<\/p>)[\s\S])*data-urgency=[\s\S]*?<\/p>/.exec(card)?.[0] ?? '';

test('given tickets graded critical, high, normal and low, when the Board is requested, then each card shows its level', async () => {
  const levels: UrgencyLevel[] = ['critical', 'high', 'normal', 'low'];
  const app = appWith([frontierOf(levels.map((_, index) => ticket({ number: index + 1, forgeReady: true, version: `v${index + 1}` })))], (store) => {
    levels.forEach((level, index) => store.urgency.recordGrade(urgencyOf(index + 1, level)));
  });

  const body = await (await app.request('/')).text();

  levels.forEach((level, index) => {
    const badge = urgencyBadgeOf(cardOf(body, index + 1));
    assert.match(badge, new RegExp(`data-urgency="${level}"`), level);
    assert.equal(readable(badge), level, level);
    assert.doesNotMatch(badge, /data-urgency-uncertain/, level);
  });
});

test('given an uncertain critical grade, when the Board is requested, then the card shows critical, marked uncertain, ordered as normal', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true, version: 'v5' })])], (store) => {
    store.urgency.recordGrade(urgencyOf(5, 'critical', { uncertain: true, confidence: 0.4, probabilities: { critical: 0.4, high: 0.3, normal: 0.2, low: 0.1 } }));
  });

  const badge = urgencyBadgeOf(cardOf(await (await app.request('/')).text(), 5));

  assert.match(badge, /data-urgency="critical"/);
  assert.match(badge, /data-urgency-uncertain/);
  assert.equal(readable(badge), 'critical uncertain, ordered as normal');
});

test('given a forge:ready ticket with no grade yet, when the Board is requested, then its card shows no urgency', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true, version: 'v5' })])]);

  assert.doesNotMatch(cardOf(await (await app.request('/')).text(), 5), /data-urgency/);
});

test('given a ticket regraded after an edit that has no grade for its new version yet, when the Board is requested, then its card keeps the earlier level', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true, version: 'v5b' })])], (store) => {
    store.urgency.recordGrade(urgencyOf(5, 'high', { version: 'v5a' }));
  });

  assert.match(urgencyBadgeOf(cardOf(await (await app.request('/')).text(), 5)), /data-urgency="high"/);
});

test('given a ticket whose grading produced no level, when the Board is requested, then its card says why the way a pull request card does', async () => {
  const cases: [GradingFailure, string, string][] = [
    ['temporary', 'OpenRouter answered 503', 'not graded temporary, retrying'],
    ['setup', 'OpenRouter rejected the key', 'not graded setup, retrying'],
    ['bug', 'OpenRouter rejected the request with 400', 'not graded bug, retrying'],
    ['declined', 'Jev declined to answer', 'declined'],
    ['too-large', "the input does not fit Jev's context window", 'too large'],
  ];
  for (const [category, message, text] of cases) {
    const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true, version: 'v5' })])], (store) => {
      store.urgency.recordAttempt({ repository: 'forge', number: 5, version: 'v5', attemptedAt: '2026-10-02T10:00:00.000Z', category, message });
    });

    const badge = urgencyBadgeOf(cardOf(await (await app.request('/')).text(), 5));

    assert.match(badge, new RegExp(`data-urgency="${category}"`), category);
    assert.equal(readable(badge), text, category);
    assert.match(badge, new RegExp(`title="Not graded: ${message.replace(/[()]/g, '\\$&').replace(/'/g, '&#39;')}`), category);
  }
});

test('given a failed attempt on an earlier version of a ticket, when the Board is requested, then its card shows no urgency', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true, version: 'v5b' })])], (store) => {
    store.urgency.recordAttempt({ repository: 'forge', number: 5, version: 'v5a', attemptedAt: '2026-10-02T10:00:00.000Z', category: 'declined', message: 'Jev declined to answer' });
  });

  assert.doesNotMatch(cardOf(await (await app.request('/')).text(), 5), /data-urgency/);
});

test('given a ticket edited after it was graded whose regrade failed, when the Board is requested, then its card shows the failed attempt instead of the earlier level', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true, version: 'v5b' })])], (store) => {
    store.urgency.recordGrade(urgencyOf(5, 'high', { version: 'v5a' }));
    store.urgency.recordAttempt({ repository: 'forge', number: 5, version: 'v5b', attemptedAt: '2026-10-02T10:00:00.000Z', category: 'declined', message: 'Jev declined to answer' });
  });

  const badge = urgencyBadgeOf(cardOf(await (await app.request('/')).text(), 5));

  assert.match(badge, /data-urgency="declined"/);
  assert.equal(readable(badge), 'declined');
});

const graded = (store: Store, repository: string, number: number, level: UrgencyLevel, uncertain = false): void =>
  store.urgency.recordGrade({
    repository,
    number,
    version: `v${number}`,
    fingerprint: 'fingerprint',
    model: 'typesafe/jev-1.13',
    probabilities: { critical: 0.25, high: 0.25, normal: 0.25, low: 0.25 },
    score: 0.5,
    confidence: uncertain ? 0.3 : 0.9,
    level,
    uncertain,
    costUsd: 0,
    gradedAt: '2026-09-29T08:00:00.000Z',
  });

const READY = { forgeReady: true, parent: null } as const;

const urgencyBoard = (order: 'oldest' | 'urgency') =>
  appWith(
    [
      frontierOf([
        ticket({ number: 1, ...READY, createdAt: '2026-09-20T10:00:00Z', version: 'v1' }),
        ticket({ number: 2, ...READY, createdAt: '2026-09-21T10:00:00Z', version: 'v2' }),
        ticket({ number: 3, ...READY, createdAt: '2026-09-22T10:00:00Z', version: 'v3' }),
        ticket({ number: 4, ...READY, createdAt: '2026-09-23T10:00:00Z', version: 'v4', blocked: true, blockedBy: [3] }),
        ticket({ number: 5, ...READY, createdAt: '2026-09-24T10:00:00Z', version: 'v5' }),
      ]),
      { ...frontierOf([ticket({ number: 9, ...READY, createdAt: '2026-09-25T10:00:00Z', version: 'v9' })]), repository: 'dotfiles', github: 'rameezk/dotfiles' },
    ],
    (store) => {
      graded(store, 'forge', 1, 'normal');
      graded(store, 'forge', 2, 'critical', true);
      graded(store, 'forge', 3, 'low');
      graded(store, 'forge', 4, 'critical');
      graded(store, 'forge', 5, 'high');
      graded(store, 'dotfiles', 9, 'normal');
    },
    undefined,
    undefined,
    undefined,
    { dispatchOrder: order, repositoryPriorities: { dotfiles: 10 } },
  );

test('given the urgency order, graded tickets across two repositories of different priorities, an uncertain critical grade and a low blocker of a critical ticket, when the Board is requested, then cards and lanes follow the order the dispatch pass takes them in', async () => {
  const body = await (await urgencyBoard('urgency').request('/')).text();

  assert.deepEqual(sections(body).map((section) => /data-repository="([^"]*)"/.exec(openingTag(section))?.[1]), ['forge', 'dotfiles']);
  assert.deepEqual(cardsByColumn(laneOf(body, 'forge'))['waiting-for-slot'], ['3', '5', '1', '2']);
});

test('given the urgency order and a repository of higher priority holding only normal tickets, when the Board is requested, then it comes before a lower priority repository holding only normal tickets', async () => {
  const body = await (
    await appWith(
      [
        frontierOf([ticket({ number: 1, ...READY })]),
        { ...frontierOf([ticket({ number: 9, ...READY })]), repository: 'dotfiles', github: 'rameezk/dotfiles' },
      ],
      () => {},
      undefined,
      undefined,
      undefined,
      { dispatchOrder: 'urgency', repositoryPriorities: { dotfiles: 10 } },
    ).request('/')
  ).text();

  assert.deepEqual(sections(body).map((section) => /data-repository="([^"]*)"/.exec(openingTag(section))?.[1]), ['dotfiles', 'forge']);
});

test('given the oldest order and graded tickets, when the Board is requested, then cards and lanes stay oldest first and ignore the grades', async () => {
  const body = await (await urgencyBoard('oldest').request('/')).text();

  assert.deepEqual(sections(body).map((section) => /data-repository="([^"]*)"/.exec(openingTag(section))?.[1]), ['dotfiles', 'forge']);
  assert.deepEqual(cardsByColumn(laneOf(body, 'forge'))['waiting-for-slot'], ['1', '2', '3', '5']);
});
