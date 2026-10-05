import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import type { PolledFrontier, PollFailure, Ticket } from '@forge/shared';
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

const appWith = (frontier: Seed[], dispatch: (store: Store) => void = () => {}) => {
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
  });
};

const sections = (body: string): string[] =>
  body.match(/<section[^>]*\sdata-repository="[^"]*"[\s\S]*?<\/section>/g) ?? [];

const ticketRows = (section: string): string[] =>
  section.match(/<tr[^>]*\sdata-ticket="[^"]*"[\s\S]*?<\/tr>/g) ?? [];

test('given a stored frontier across two repositories, when the work page is requested, then tickets are grouped by repository oldest first, each with its link, parent spec and creation date, under the repository linked to GitHub with its last-polled time', async () => {
  const app = appWith([
    {
      repository: 'forge',
      github: 'rameezk/forge',
      polledAt: '2026-09-29T08:15:00.000Z',
      tickets: [
        ticket({ number: 70, title: 'Billed cost settles after the run', url: 'https://github.com/rameezk/forge/issues/70', parent: { number: 67, title: 'Billed cost settles after the run', url: 'https://github.com/rameezk/forge/issues/67' }, createdAt: '2026-09-28T12:26:54Z' }),
        ticket(),
      ],
    },
    {
      repository: 'dotfiles',
      github: 'rameezk/dotfiles',
      polledAt: '2026-09-29T08:10:00.000Z',
      tickets: [
        ticket({ number: 3, title: 'Unparented chore', url: 'https://github.com/rameezk/dotfiles/issues/3', parent: null, createdAt: '2026-09-01T09:00:00Z' }),
      ],
    },
  ]);

  const res = await app.request('/work');
  assert.equal(res.status, 200);
  const [dotfiles, forge, ...rest] = sections(await res.text());
  assert.deepEqual(rest, []);
  assert.ok(dotfiles && forge);

  assert.match(forge, /<h2[^>]*>forge<\/h2>/);
  assert.match(forge, /<a href="https:\/\/github\.com\/rameezk\/forge"[^>]*>rameezk\/forge<\/a>/);
  assert.match(forge, /Last polled <time datetime="2026-09-29T08:15:00.000Z" title="2026-09-29T08:15:00.000Z"[^>]*>2026-09-29 08:15:00 UTC<\/time>/);
  const rows = ticketRows(forge);
  assert.deepEqual(rows.map(textOf), [
    '#56 Declared repositories show their frontier on the dashboard #54 Frontier discovery across managed repositories 2026-09-28',
    '#70 Billed cost settles after the run #67 Billed cost settles after the run 2026-09-28',
  ]);
  assert.match(rows[0] ?? '', /<a href="https:\/\/github\.com\/rameezk\/forge\/issues\/56"[^>]*>#56<\/a>/);
  assert.match(rows[0] ?? '', /<span class="tabular-nums"><a href="https:\/\/github\.com\/rameezk\/forge\/issues\/54" target="_blank" rel="noopener noreferrer"[^>]*>#54<\/a><\/span> Frontier discovery/);
  assert.match(rows[0] ?? '', /<time datetime="2026-09-28T10:07:58Z" title="2026-09-28T10:07:58Z"[^>]*>2026-09-28<\/time>/);

  assert.match(dotfiles, /<h2[^>]*>dotfiles<\/h2>/);
  assert.match(dotfiles, /<a href="https:\/\/github\.com\/rameezk\/dotfiles"[^>]*>rameezk\/dotfiles<\/a>/);
  assert.deepEqual(ticketRows(dotfiles).map(textOf), ['#3 Unparented chore No spec 2026-09-01']);
});

test('given a ticket whose parent spec URL is not a GitHub https link, when the work page is requested, then the spec renders its number and title without a link', async () => {
  const app = appWith([
    {
      repository: 'forge',
      github: 'rameezk/forge',
      polledAt: '2026-09-29T08:15:00.000Z',
      tickets: [ticket({ parent: { number: 54, title: 'Frontier discovery', url: 'javascript:alert(1)' } })],
    },
  ]);

  const [forge] = sections(await (await app.request('/work')).text());
  const [row] = ticketRows(forge ?? '');

  assert.match(textOf(row ?? ''), /#54 Frontier discovery/);
  assert.doesNotMatch(row ?? '', /#54<\/a>/);
  assert.doesNotMatch(row ?? '', /javascript:/);
});

test('given a polled repository with nothing on its frontier, when the work page is requested, then it says so under the repository', async () => {
  const app = appWith([{ repository: 'forge', github: 'rameezk/forge', polledAt: '2026-09-29T08:15:00.000Z', tickets: [] }]);

  const [forge] = sections(await (await app.request('/work')).text());

  assert.match(forge ?? '', /<p[^>]*>No tickets on the frontier\.<\/p>/);
  assert.doesNotMatch(forge ?? '', /<table[\s>]/);
});

test('given no repository has been polled, when the work page is requested, then it says the frontier has not been polled yet', async () => {
  const body = await (await appWith([]).request('/work')).text();

  assert.match(body, /<p[^>]*>No managed repositories have been polled yet\.<\/p>/);
});

test('given the dashboard, when the runs and work pages are requested, then both carry a header linking Runs and Work that marks the current page', async () => {
  const app = appWith([]);
  const nav = async (path: string): Promise<string> =>
    (await (await app.request(path)).text()).match(/<nav[^>]*>[\s\S]*?<\/nav>/)?.[0] ?? '';

  assert.match(await nav('/'), /<a href="\/" aria-current="page"[^>]*>Runs<\/a>\s*<a href="\/work"(?![^>]*aria-current)[^>]*>Work<\/a>/);
  assert.match(await nav('/work'), /<a href="\/"(?![^>]*aria-current)[^>]*>Runs<\/a>\s*<a href="\/work" aria-current="page"[^>]*>Work<\/a>/);
});

test('given a stored ticket whose url is not a GitHub https link, when the work page is requested, then its number renders without a link', async () => {
  const app = appWith([
    {
      repository: 'forge',
      github: 'rameezk/forge',
      polledAt: '2026-09-29T08:15:00.000Z',
      tickets: [ticket({ url: 'javascript:alert(1)' })],
    },
  ]);

  const [row] = ticketRows(sections(await (await app.request('/work')).text())[0] ?? '');

  assert.doesNotMatch(row ?? '', /javascript:/);
  assert.match(row ?? '', /<td[^>]*>#56<\/td>/);
});

test('given a stored snapshot where one repository has a last error, when the work page is requested, then that repository shows its error and last-polled time alongside its stale tickets', async () => {
  const app = appWith([
    {
      repository: 'forge',
      github: 'rameezk/forge',
      polledAt: '2026-09-29T08:15:00.000Z',
      lastError: { message: 'GitHub answered 401 for rameezk/forge', failedAt: '2026-09-29T08:20:00.000Z' },
      tickets: [ticket()],
    },
    { repository: 'healthy', github: 'rameezk/healthy', polledAt: '2026-09-29T08:20:00.000Z', tickets: [] },
  ]);

  const [forge, healthy] = sections(await (await app.request('/work')).text());

  assert.match(openingTag(forge ?? ''), /\sdata-stale[\s>]/);
  assert.match(forge ?? '', /<p[^>]*\sdata-poll-error[^>]*>Last poll failed <time datetime="2026-09-29T08:20:00.000Z" title="2026-09-29T08:20:00.000Z"[^>]*>2026-09-29 08:20:00 UTC<\/time>: GitHub answered 401 for rameezk\/forge<\/p>/);
  assert.match(forge ?? '', /Last polled <time datetime="2026-09-29T08:15:00.000Z"/);
  assert.equal(ticketRows(forge ?? '').length, 1);
  assert.doesNotMatch(healthy ?? '', /data-poll-error|data-stale/);
});

test('given a repository that has never been polled successfully, when the work page is requested, then it shows its error and that it was never polled', async () => {
  const app = appWith([
    { repository: 'forge', github: 'rameezk/forge', polledAt: null, lastError: { message: 'GitHub token missing', failedAt: '2026-09-29T08:20:00.000Z' } },
  ]);

  const [forge] = sections(await (await app.request('/work')).text());

  assert.match(forge ?? '', /<p[^>]*\sdata-poll-error[^>]*>Last poll failed <time[^>]*>[^<]*<\/time>: GitHub token missing<\/p>/);
  assert.match(forge ?? '', /<span[^>]*>Never polled<\/span>/);
  assert.doesNotMatch(forge ?? '', /No tickets on the frontier/);
});

test('given a stored repository whose github is not an owner/name, when the work page is requested, then it renders without a link', async () => {
  const app = appWith([
    { repository: 'forge', github: '../../evil', polledAt: null, lastError: { message: 'GitHub token missing', failedAt: '2026-09-29T08:20:00.000Z' } },
  ]);

  const [forge] = sections(await (await app.request('/work')).text());

  assert.doesNotMatch(forge ?? '', /<a href="https:\/\/github\.com\/\.\.\/\.\.\/evil"/);
  assert.match(forge ?? '', /<span[^>]*>\.\.\/\.\.\/evil<\/span>/);
});

test('given frontier tickets that forge dispatched, one running, one done, one failed for each reason including a devShell that failed, one whose dispatch stopped beating, one whose run never started, and one never dispatched, when the work page is requested, then each shows its dispatch state, and a failed one its reason, linked to its run when that run exists', async () => {
  const numbers = [56, 57, 58, 59, 60, 61, 62, 63, 64, 65];
  const at = '2026-09-30T08:00:00.000Z';
  const forgeTicket = (number: number) => ({
    repository: 'forge',
    number,
    url: `https://github.com/rameezk/forge/issues/${number}`,
  });
  const app = appWith(
    [
      {
        repository: 'forge',
        github: 'rameezk/forge',
        polledAt: '2026-09-29T08:15:00.000Z',
        tickets: numbers.map((number) => ticket({ number, title: `Ticket ${number}`, url: forgeTicket(number).url, parent: null })),
      },
    ],
    (store) => {
      const dispatched = (number: number, startedAt = new Date().toISOString()) => {
        const start = store.startDispatch(forgeTicket(number), `run-${number}`, startedAt, Number.POSITIVE_INFINITY);
        assert.ok('started' in start);
        const id = start.started;
        if (number !== 63) {
          store.insertRun({
            id: `run-${number}`,
            worker: 'builder',
            harness: 'pi',
            model: 'z-ai/glm-5',
            startTime: startedAt,
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
          });
        }
        return id;
      };
      dispatched(56);
      store.endDispatch(dispatched(57), { state: 'done' }, at);
      store.endDispatch(dispatched(58), { state: 'failed', reason: 'errored', detail: 'git could not clone rameezk/forge' }, at);
      store.endDispatch(dispatched(59), { state: 'failed', reason: 'no-pull-request', detail: 'Should the check use <b>REST</b>?' }, at);
      store.endDispatch(dispatched(60), { state: 'failed', reason: 'skill-not-found', detail: "skill 'work-on' not found in the checkout" }, at);
      store.reconcileDispatch(forgeTicket(61), at);
      dispatched(62, '2026-09-01T09:00:00.000Z');
      store.endDispatch(dispatched(63), { state: 'failed', reason: 'errored', detail: 'could not claim the ticket: GitHub answered 403' }, at);
      store.endDispatch(dispatched(65), { state: 'failed', reason: 'devshell-failed', detail: "nix print-dev-env exited with code 1: error: undefined variable 'mkShel'" }, at);
    },
  );

  const rows = ticketRows(sections(await (await app.request('/work')).text())[0] ?? '');

  const dispatchCell = (row: string): string =>
    row.match(/<td[^>]*\sdata-dispatch(?:="[^"]*")?[^>]*>[\s\S]*?<\/td>/)?.[0] ?? '';
  assert.deepEqual(
    rows.map((row) => [textOf(dispatchCell(row)), /data-dispatch="([^"]*)"/.exec(row)?.[1] ?? null]),
    [
      ['running', 'running'],
      ['done', 'done'],
      ['failed Run errored: git could not clone rameezk/forge', 'failed'],
      ['failed No pull request: Should the check use &lt;b&gt;REST&lt;/b&gt;?', 'failed'],
      ["failed Skill not found: skill &#39;work-on&#39; not found in the checkout", 'failed'],
      ['failed Interrupted', 'failed'],
      ['failed Interrupted', 'failed'],
      ['failed Run errored: could not claim the ticket: GitHub answered 403', 'failed'],
      ['', null],
      ["failed devShell failed: nix print-dev-env exited with code 1: error: undefined variable &#39;mkShel&#39;", 'failed'],
    ],
  );
  assert.deepEqual(
    rows.map((row) => /<a href="(\/runs\/[^"]*)"/.exec(dispatchCell(row))?.[1] ?? null),
    ['/runs/run-56', '/runs/run-57', '/runs/run-58', '/runs/run-59', '/runs/run-60', null, '/runs/run-62', null, null, '/runs/run-65'],
  );
  assert.doesNotMatch(rows[3] ?? '', /<b>REST<\/b>/);
});

test('given a repository whose snapshot holds a queued ticket, labelled forge:ready but still blocked, one that failed before it was relabelled forge:ready while blocked, and an unlabelled frontier ticket, when the work page is requested, then both labelled ones show as queued, unlinked, beside the frontier ticket in age order', async () => {
  const at = '2026-09-30T08:00:00.000Z';
  const app = appWith(
    [
      {
        repository: 'forge',
        github: 'rameezk/forge',
        polledAt: '2026-09-29T08:15:00.000Z',
        tickets: [
          ticket({ number: 64, title: 'Pinned host key', url: 'https://github.com/rameezk/forge/issues/64', createdAt: '2026-09-28T11:32:31Z', forgeReady: true, blocked: true }),
          ticket({ number: 65, title: 'Retried while blocked', url: 'https://github.com/rameezk/forge/issues/65', createdAt: '2026-09-28T11:40:00Z', forgeReady: true, blocked: true }),
          ticket(),
        ],
      },
    ],
    (store) => {
      const start = store.startDispatch(
        { repository: 'forge', number: 65, url: 'https://github.com/rameezk/forge/issues/65' },
        'run-65',
        at,
        Number.POSITIVE_INFINITY,
      );
      assert.ok('started' in start);
      store.endDispatch(start.started, { state: 'failed', reason: 'no-pull-request', detail: 'Which token?' }, at);
    },
  );

  const rows = ticketRows(sections(await (await app.request('/work')).text())[0] ?? '');

  assert.deepEqual(
    rows.map((row) => [/data-ticket="(\d+)"/.exec(row)?.[1], /data-dispatch="([^"]*)"/.exec(row)?.[1] ?? null]),
    [
      ['56', null],
      ['64', 'queued'],
      ['65', 'queued'],
    ],
  );
  assert.match(rows[1] ?? '', /<td[^>]*data-dispatch="queued"[^>]*><span[^>]*>queued<\/span><\/td>/);
  assert.doesNotMatch(rows[2] ?? '', /\/runs\/|Which token/);
});
