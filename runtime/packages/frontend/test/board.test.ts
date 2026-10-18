import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import type { ClosedTicket, PolledFrontier, PollFailure, RefinementRequest, RunRecord, Ticket } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
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
  | (PolledFrontier & { lastError?: PollFailure })
  | { repository: string; github: string; polledAt: null; lastError: PollFailure };

const appWith = (frontier: Seed[], dispatch: (store: Store) => void = () => {}, maxConcurrent?: number) => {
  const store = Store.open(':memory:');
  dispatch(store);
  for (const seed of frontier) {
    if (seed.polledAt !== null) store.replaceFrontier(seed);
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
      ['running', 'Running', '0', 'An agent is building it', 'An agent is building it', false],
      ['in-review', 'In review', '0', 'Needs a human in the loop', 'Needs a human in the loop', true],
      ['failed', 'Failed', '0', 'Agent run failed', 'Set forge:ready to retry', false],
      ['done', 'Done', '0', 'Closed in the last 7 days', 'Closed in the last 7 days', false],
    ],
  );
});

const forgeTicket = (number: number) => ({ repository: 'forge', number, url: `https://github.com/rameezk/forge/issues/${number}` });

const dispatched = (store: Store, number: number, startedAt = '2026-09-30T08:00:00.000Z'): number => {
  const start = store.startDispatch(forgeTicket(number), `run-${number}`, startedAt, Number.POSITIVE_INFINITY);
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
      store.endDispatch(dispatched(store, 5), { state: 'done', pullRequest: pullRequest(105) }, '2026-09-30T09:00:00.000Z');
      store.endDispatch(dispatched(store, 6), { state: 'failed', reason: 'errored', detail: null }, '2026-09-30T09:00:00.000Z');
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
    store.endDispatch(id, { state: 'done', pullRequest: pullRequest(105) }, '2026-09-30T09:00:00.000Z');
    store.recordPullRequest(id, { state: 'closed', settledAt: '2026-09-30T10:00:00.000Z', rework: 0 });
  });

  const body = await (await app.request('/')).text();

  assert.deepEqual(populated(cardsByColumn(laneOf(body, 'forge'))), { failed: ['5'] });
  assert.match(textOf(cardOf(body, 5)), /Pull request closed/);
});

test('given a done dispatch with an open pull request and a running revision on it, when the Board is requested, then the ticket is in In review with a revising marker, and a ticket whose pull request is not being revised has none', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true }), ticket({ number: 6, forgeReady: true })])], (store) => {
    store.endDispatch(dispatched(store, 5), { state: 'done', pullRequest: pullRequest(105) }, '2026-09-30T09:00:00.000Z');
    store.endDispatch(dispatched(store, 6), { state: 'done', pullRequest: pullRequest(106) }, '2026-09-30T09:00:00.000Z');
    const start = store.startRevision({ repository: 'forge', ...pullRequest(105) }, [5], 'revision-105', new Date().toISOString(), Number.POSITIVE_INFINITY);
    assert.ok('started' in start);
  });

  const body = await (await app.request('/')).text();

  assert.deepEqual(populated(cardsByColumn(laneOf(body, 'forge'))), { 'in-review': ['5', '6'] });
  assert.match(cardOf(body, 5), /data-revising[^>]*>\s*revising\s*</);
  assert.doesNotMatch(cardOf(body, 6), /data-revising/);
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
      store.endDispatch(id, { state: 'done', pullRequest: pullRequest(111) }, '2026-09-28T09:00:00.000Z');
      store.recordPullRequest(id, { state: 'merged', settledAt: '2026-09-28T10:00:00.000Z', rework: 0 });
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
      store.insertRun(runOf(4));
      dispatched(store, 4, new Date().toISOString());
      store.endDispatch(dispatched(store, 5), { state: 'done', pullRequest: pullRequest(105) }, '2026-09-30T09:00:00.000Z');
      store.endDispatch(dispatched(store, 6), { state: 'failed', reason: 'no-pull-request', detail: 'Should the check use <b>REST</b>?' }, '2026-09-30T09:00:00.000Z');
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
      store.endDispatch(dispatched(store, 5), { state: 'failed', reason: 'draft', detail: null }, '2026-09-30T09:00:00.000Z');
      store.endDispatch(dispatched(store, 6), { state: 'failed', reason: 'check-failed', detail: 'lint, vm' }, '2026-09-30T09:00:00.000Z');
      store.endDispatch(dispatched(store, 7), { state: 'failed', reason: 'check-pending', detail: 'build' }, '2026-09-30T09:00:00.000Z');
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
    store.endDispatch(dispatched(store, 5, now), { state: 'done', pullRequest: pullRequest(105) }, now);
    const start = store.startRevision({ repository: 'forge', ...pullRequest(105) }, [5], 'revision-105', now, Number.POSITIVE_INFINITY);
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
    store.endDispatch(dispatched(store, 5), { state: 'done', pullRequest: pullRequest(105) }, '2026-09-30T09:00:00.000Z');
  });

  const card = cardOf(await (await app.request('/')).text(), 5);

  assert.match(textOf(card), /PR #105$/);
  assert.doesNotMatch(card, /data-elapsed-since|data-revising/);
});

test('given a done dispatch with an open pull request and a running revision, when the Board is requested, then the card shows a revising pill linking to the revision run page and an elapsed time from the revision run harness start', async () => {
  const app = appWith([frontierOf([ticket({ number: 5, forgeReady: true })])], (store) => {
    store.endDispatch(dispatched(store, 5), { state: 'done', pullRequest: pullRequest(105) }, '2026-09-30T09:00:00.000Z');
    store.insertRun({ ...runOf(105), id: 'revision-105', startTime: '2026-09-30T10:00:00.000Z', harnessStartTime: '2026-09-30T10:05:00.000Z' });
    const start = store.startRevision({ repository: 'forge', ...pullRequest(105) }, [5], 'revision-105', new Date().toISOString(), Number.POSITIVE_INFINITY);
    assert.ok('started' in start);
  });

  const card = cardOf(await (await app.request('/')).text(), 5);

  assert.match(card, /<a href="\/runs\/revision-105"[^>]*><span[^>]*data-revising[^>]*>revising<\/span><\/a>/);
  assert.match(card, /data-elapsed-since="2026-09-30T10:05:00.000Z"/);
  assert.equal(card.match(/data-elapsed-since/g)?.length, 1);
});

test('given a running dispatch whose run has no harness start time, when the Board is requested, then the Running card counts from the run start time', async () => {
  const app = appWith([frontierOf([ticket({ number: 4, forgeReady: true })])], (store) => {
    store.insertRun({ ...runOf(4), startTime: '2026-09-30T08:01:00.000Z' });
    dispatched(store, 4, new Date().toISOString());
  });

  assert.match(cardOf(await (await app.request('/')).text(), 4), /data-elapsed-since="2026-09-30T08:01:00.000Z"/);
});

test('given a running dispatch whose run has a later harness start time, when the Board and the run page are requested, then both count from the same instant', async () => {
  const app = appWith([frontierOf([ticket({ number: 4, forgeReady: true })])], (store) => {
    store.insertRun({ ...runOf(4), harnessStartTime: '2026-09-30T08:03:00.000Z' });
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
