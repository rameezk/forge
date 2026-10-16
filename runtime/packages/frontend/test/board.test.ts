import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import type { PolledFrontier, PollFailure, RunRecord, Ticket } from '@forge/shared';
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
    [['/', 'Board', true], ['/runs', 'Runs', false], ['/insights', 'Insights', false]],
  );

  const work = await app.request('/work');
  assert.equal(work.status, 302);
  assert.equal(work.headers.get('location'), '/');

  const runs = await (await app.request('/runs')).text();
  assert.match(runs.match(/<nav[^>]*>[\s\S]*?<\/nav>/)?.[0] ?? '', /<a href="\/runs" aria-current="page"[^>]*>Runs<\/a>/);
});

const columnHeaders = (body: string): string[] =>
  body.match(/<div[^>]*\sdata-column-header="[^"]*"[\s\S]*?<\/div>/g) ?? [];

test('given a stored frontier, when the Board is requested, then it shows the nine columns in order, each with its title, total and subtitle, and a person icon on To refine, Ready for human and In review only', async () => {
  const app = appWith([
    { repository: 'forge', github: 'rameezk/forge', polledAt: '2026-09-29T08:15:00.000Z', tickets: [ticket()] },
  ]);

  const headers = columnHeaders(await (await app.request('/')).text());

  assert.deepEqual(
    headers.map((header) => [/data-column-header="([^"]*)"/.exec(header)?.[1], /data-column-title[^>]*>([^<]*)</.exec(header)?.[1], /data-column-total[^>]*>([^<]*)</.exec(header)?.[1], /data-column-subtitle[^>]*>([^<]*)</.exec(header)?.[1], /data-person/.test(header)]),
    [
      ['to-refine', 'To refine', '0', 'Shape into a spec and tickets', true],
      ['blocked', 'Blocked', '0', 'Waiting on open blockers', false],
      ['ready-for-human', 'Ready for human', '0', 'A person builds it', true],
      ['ready-for-agent', 'Ready for agent', '1', 'Add forge:ready to hand off', false],
      ['waiting-for-slot', 'Waiting for slot', '0', 'Handed off, unblocked', false],
      ['running', 'Running', '0', 'An agent is building it', false],
      ['in-review', 'In review', '0', 'PR waiting on a human', true],
      ['failed', 'Failed', '0', 'Set forge:ready to retry', false],
      ['done', 'Done', '0', 'Closed in the last 7 days', false],
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

const frontierOf = (tickets: Ticket[]): PolledFrontier => ({ repository: 'forge', github: 'rameezk/forge', polledAt: '2026-09-29T08:15:00.000Z', tickets });

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

test('given tickets with attempts, a parent spec, and dispatches in each state, when the Board is requested, then each card shows its linked number, title, parent spec tooltip, attempts link and its column details, oldest first within each column', async () => {
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
  assert.match(openingTag(cardOf(body, 2)), /title="#54 Frontier discovery across managed repositories"/);
  assert.doesNotMatch(openingTag(cardOf(body, 7)), /title=/);
  assert.match(cardOf(body, 2), /<a href="https:\/\/github\.com\/rameezk\/forge\/issues\/56"[^>]*>#2<\/a>/);
  assert.match(textOf(cardOf(body, 2)), /Declared repositories show their frontier on the dashboard 2026-09-22$/);
  assert.doesNotMatch(cardOf(body, 2), /data-attempts/);

  assert.match(textOf(cardOf(body, 1)), /queued/);
  assert.match(cardOf(body, 1), /<span[^>]*data-queued[^>]*>queued<\/span>/);
  assert.match(textOf(cardOf(body, 3)), /2026-09-23$/);

  assert.match(cardOf(body, 4), /<a href="\/runs\/run-4"[^>]*><span[^>]*>running<\/span><\/a>/);
  assert.match(cardOf(body, 4), /data-elapsed-since="\d{4}-\d{2}-\d{2}T/);
  assert.match(cardOf(body, 4), /<a href="\/tickets\/forge\/4"[^>]*data-attempts[^>]*>/);

  assert.match(cardOf(body, 5), /<a href="https:\/\/github\.com\/rameezk\/forge\/pull\/105"[^>]*>PR #105<\/a>/);
  assert.match(cardOf(body, 5), /data-elapsed-since="2026-09-30T09:00:00.000Z"/);

  assert.match(textOf(cardOf(body, 6)), /No pull request: Should the check use &lt;b&gt;REST&lt;\/b&gt;\?/);
  assert.doesNotMatch(cardOf(body, 6), /<b>REST<\/b>/);
});

test('given two repositories, one with a poll error, when the Board is requested, then each has its own lane with its GitHub link and last-polled time, the failing one shows its error in its lane, and each column total counts both', async () => {
  const app = appWith([
    { ...frontierOf([ticket({ number: 1 }), ticket({ number: 2, forgeReady: true })]), lastError: { message: 'GitHub answered 401 for rameezk/forge', failedAt: '2026-09-29T08:20:00.000Z' } },
    { repository: 'dotfiles', github: 'rameezk/dotfiles', polledAt: '2026-09-29T08:10:00.000Z', tickets: [ticket({ number: 3, url: 'https://github.com/rameezk/dotfiles/issues/3', parent: null })] },
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
