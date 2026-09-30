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
  parent: { number: 54, title: 'Frontier discovery across managed repositories' },
  createdAt: '2026-09-28T10:07:58Z',
  ...overrides,
});

type Seed =
  | (PolledFrontier & { lastError?: PollFailure })
  | { repository: string; github: string; polledAt: null; lastError: PollFailure };

const appWith = (frontier: Seed[]) => {
  const store = Store.open(':memory:');
  for (const seed of frontier) {
    if (seed.polledAt !== null) store.replaceFrontier(seed);
    if (seed.lastError !== undefined) {
      store.recordFrontierError({ repository: seed.repository, github: seed.github, ...seed.lastError });
    }
  }
  return createApp({
    store,
    transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))),
    stylesheet: '',
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
        ticket({ number: 70, title: 'Billed cost settles after the run', url: 'https://github.com/rameezk/forge/issues/70', parent: { number: 67, title: 'Billed cost settles after the run' }, createdAt: '2026-09-28T12:26:54Z' }),
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

  assert.match(forge, /<h2>forge<\/h2>/);
  assert.match(forge, /<a href="https:\/\/github\.com\/rameezk\/forge">rameezk\/forge<\/a>/);
  assert.match(forge, /Last polled <time datetime="2026-09-29T08:15:00.000Z" title="2026-09-29T08:15:00.000Z">2026-09-29 08:15:00 UTC<\/time>/);
  const rows = ticketRows(forge);
  assert.deepEqual(rows.map(textOf), [
    '#56 Declared repositories show their frontier on the dashboard #54 Frontier discovery across managed repositories 2026-09-28',
    '#70 Billed cost settles after the run #67 Billed cost settles after the run 2026-09-28',
  ]);
  assert.match(rows[0] ?? '', /<a href="https:\/\/github\.com\/rameezk\/forge\/issues\/56">#56<\/a>/);
  assert.match(rows[0] ?? '', /<time datetime="2026-09-28T10:07:58Z" title="2026-09-28T10:07:58Z">2026-09-28<\/time>/);

  assert.match(dotfiles, /<h2>dotfiles<\/h2>/);
  assert.match(dotfiles, /<a href="https:\/\/github\.com\/rameezk\/dotfiles">rameezk\/dotfiles<\/a>/);
  assert.deepEqual(ticketRows(dotfiles).map(textOf), ['#3 Unparented chore No spec 2026-09-01']);
});

test('given a polled repository with nothing on its frontier, when the work page is requested, then it says so under the repository', async () => {
  const app = appWith([{ repository: 'forge', github: 'rameezk/forge', polledAt: '2026-09-29T08:15:00.000Z', tickets: [] }]);

  const [forge] = sections(await (await app.request('/work')).text());

  assert.match(forge ?? '', /<p[^>]*>No tickets on the frontier\.<\/p>/);
  assert.doesNotMatch(forge ?? '', /<table>/);
});

test('given no repository has been polled, when the work page is requested, then it says the frontier has not been polled yet', async () => {
  const body = await (await appWith([]).request('/work')).text();

  assert.match(body, /<p[^>]*>No managed repositories have been polled yet\.<\/p>/);
});

test('given the dashboard, when the runs and work pages are requested, then both carry a header linking Runs and Work that marks the current page', async () => {
  const app = appWith([]);
  const nav = async (path: string): Promise<string> =>
    (await (await app.request(path)).text()).match(/<nav>[\s\S]*?<\/nav>/)?.[0] ?? '';

  assert.match(await nav('/'), /<a href="\/" aria-current="page">Runs<\/a>\s*<a href="\/work">Work<\/a>/);
  assert.match(await nav('/work'), /<a href="\/">Runs<\/a>\s*<a href="\/work" aria-current="page">Work<\/a>/);
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
  assert.match(forge ?? '', /<p[^>]*\sdata-poll-error[^>]*>Last poll failed <time datetime="2026-09-29T08:20:00.000Z" title="2026-09-29T08:20:00.000Z">2026-09-29 08:20:00 UTC<\/time>: GitHub answered 401 for rameezk\/forge<\/p>/);
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
