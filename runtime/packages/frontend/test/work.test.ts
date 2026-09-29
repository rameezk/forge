import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import type { RepositoryFrontier, Ticket } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';

const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  number: 56,
  title: 'Declared repositories show their frontier on the dashboard',
  url: 'https://github.com/rameezk/forge/issues/56',
  parent: { number: 54, title: 'Frontier discovery across managed repositories' },
  createdAt: '2026-09-28T10:07:58Z',
  ...overrides,
});

type Seed = Omit<RepositoryFrontier, 'lastError'> & { lastError?: string };

const appWith = (frontier: Seed[]) => {
  const store = Store.open(':memory:');
  for (const { lastError, polledAt, ...repository } of frontier) {
    if (polledAt !== null) store.replaceFrontier({ ...repository, polledAt });
    if (lastError !== undefined) store.recordFrontierError(repository.repository, repository.github, lastError);
  }
  return createApp({
    store,
    transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))),
  });
};

const textOf = (fragment: string): string =>
  fragment.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

const sections = (body: string): string[] =>
  body.match(/<section class="repository[^"]*">[\s\S]*?<\/section>/g) ?? [];

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
  const rows = forge.match(/<tr class="ticket">[\s\S]*?<\/tr>/g) ?? [];
  assert.deepEqual(rows.map(textOf), [
    '#56 Declared repositories show their frontier on the dashboard #54 Frontier discovery across managed repositories 2026-09-28',
    '#70 Billed cost settles after the run #67 Billed cost settles after the run 2026-09-28',
  ]);
  assert.match(rows[0] ?? '', /<a href="https:\/\/github\.com\/rameezk\/forge\/issues\/56">#56<\/a>/);
  assert.match(rows[0] ?? '', /<time datetime="2026-09-28T10:07:58Z" title="2026-09-28T10:07:58Z">2026-09-28<\/time>/);

  assert.match(dotfiles, /<h2>dotfiles<\/h2>/);
  assert.match(dotfiles, /<a href="https:\/\/github\.com\/rameezk\/dotfiles">rameezk\/dotfiles<\/a>/);
  assert.equal(textOf((dotfiles.match(/<tr class="ticket">[\s\S]*?<\/tr>/) ?? [''])[0]), '#3 Unparented chore No spec 2026-09-01');
});

test('given a polled repository with nothing on its frontier, when the work page is requested, then it says so under the repository', async () => {
  const app = appWith([{ repository: 'forge', github: 'rameezk/forge', polledAt: '2026-09-29T08:15:00.000Z', tickets: [] }]);

  const [forge] = sections(await (await app.request('/work')).text());

  assert.match(forge ?? '', /<p class="empty">No tickets on the frontier\.<\/p>/);
  assert.doesNotMatch(forge ?? '', /<table>/);
});

test('given no repository has been polled, when the work page is requested, then it says the frontier has not been polled yet', async () => {
  const body = await (await appWith([]).request('/work')).text();

  assert.match(body, /<p class="empty">No managed repositories have been polled yet\.<\/p>/);
});

test('given the dashboard, when the runs and work pages are requested, then both carry a header linking Runs and Work that marks the current page', async () => {
  const app = appWith([]);
  const nav = async (path: string): Promise<string> =>
    (await (await app.request(path)).text()).match(/<header class="site">[\s\S]*?<\/header>/)?.[0] ?? '';

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

  const [forge] = sections(await (await app.request('/work')).text());

  assert.doesNotMatch(forge ?? '', /javascript:/);
  assert.match(forge ?? '', /<td class="number">#56<\/td>/);
});

test('given a stored snapshot where one repository has a last error, when the work page is requested, then that repository shows its error and last-polled time alongside its stale tickets', async () => {
  const app = appWith([
    {
      repository: 'forge',
      github: 'rameezk/forge',
      polledAt: '2026-09-29T08:15:00.000Z',
      lastError: 'GitHub answered 401 for rameezk/forge',
      tickets: [ticket()],
    },
    { repository: 'healthy', github: 'rameezk/healthy', polledAt: '2026-09-29T08:20:00.000Z', tickets: [] },
  ]);

  const [forge, healthy] = sections(await (await app.request('/work')).text());

  assert.match(forge ?? '', /^<section class="repository stale">/);
  assert.match(forge ?? '', /<p class="status-error">Last poll failed: GitHub answered 401 for rameezk\/forge<\/p>/);
  assert.match(forge ?? '', /Last polled <time datetime="2026-09-29T08:15:00.000Z"/);
  assert.equal((forge?.match(/<tr class="ticket">/g) ?? []).length, 1);
  assert.doesNotMatch(healthy ?? '', /status-error|stale/);
});

test('given a repository that has never been polled successfully, when the work page is requested, then it shows its error and that it was never polled', async () => {
  const app = appWith([
    { repository: 'forge', github: 'rameezk/forge', polledAt: null, lastError: 'GitHub token missing', tickets: [] },
  ]);

  const [forge] = sections(await (await app.request('/work')).text());

  assert.match(forge ?? '', /<p class="status-error">Last poll failed: GitHub token missing<\/p>/);
  assert.match(forge ?? '', /<span class="polled">Never polled<\/span>/);
  assert.doesNotMatch(forge ?? '', /No tickets on the frontier/);
});
