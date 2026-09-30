import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { readStylesheet } from '../src/assets.ts';
import { openingTag, textOf } from './html.ts';

const appWith = ({ css = '', logo = '' }: { css?: string; logo?: string }) => {
  const store = Store.open(':memory:');
  store.insertRun({
    id: 'run-01',
    worker: 'refiner',
    harness: 'pi',
    model: 'anthropic/claude-opus-4',
    startTime: '2026-09-21T10:00:00.000Z',
    endTime: '2026-09-21T10:03:20.000Z',
    status: 'success',
    costStatus: 'billed',
    costUsd: 0.1234,
    inputTokens: 4200,
    outputTokens: 850,
    transcriptRef: null,
    sessionId: 'sess-abc',
    error: null,
  });
  return createApp({
    store,
    transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))),
    css,
    logo,
  });
};

const PAGES = ['/', '/runs/run-01', '/work'] as const;

const stylesheetLinks = (body: string): string[] =>
  [...body.matchAll(/<link[^>]*\srel="stylesheet"[^>]*>/g)].map(
    ([link]) => link.match(/\shref="([^"]*)"/)?.[1] ?? '',
  );

test('given any dashboard page, when it is requested, then it links exactly one stylesheet under a content-hashed path and contains no inline style', async () => {
  const first = appWith({ css: 'body { color: red; }' });
  const second = appWith({ css: 'body { color: blue; }' });

  for (const page of PAGES) {
    const body = await (await first.request(page)).text();
    const links = stylesheetLinks(body);
    assert.equal(links.length, 1, `${page} should link exactly one stylesheet`);
    assert.match(links[0]!, /^\/assets\/dashboard-[0-9a-f]{16,}\.css$/);
    assert.doesNotMatch(body, /<style[\s>]/i, `${page} should carry no style element`);
    assert.doesNotMatch(body, /\sstyle=/i, `${page} should carry no style attribute`);

    const other = stylesheetLinks(await (await second.request(page)).text());
    assert.notEqual(other[0], links[0], 'a different stylesheet should get a different path');
  }
});

test('given the hashed stylesheet path a page links to, when it is requested, then it returns the CSS with an immutable, long-lived cache header', async () => {
  const css = 'body { color: red; }';
  const app = appWith({ css });
  const [path] = stylesheetLinks(await (await app.request('/')).text());

  const res = await app.request(path!);

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/css\b/);
  const cacheControl = (res.headers.get('cache-control') ?? '').split(/,\s*/);
  assert.ok(cacheControl.includes('immutable'), 'the stylesheet should be cached as immutable');
  const maxAge = Number(cacheControl.find((d) => d.startsWith('max-age='))?.slice('max-age='.length));
  assert.ok(maxAge >= 31536000, 'the stylesheet should be cached for at least a year');
  assert.equal(await res.text(), css);

  const stale = await app.request('/assets/dashboard-0000000000000000.css');
  assert.equal(stale.status, 404, 'a path for any other content should not be served');
});

test('given the stylesheet has not been built, when the dashboard reads it, then it fails naming the missing file and how to build it', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'forge-dist-')), 'dashboard.css');

  assert.throws(() => readStylesheet(missing), (error: Error) =>
    error.message.includes(missing) && error.message.includes('npm run build'),
  );
});

const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><circle cx="64" cy="64" r="8"/></svg>\n';

const attribute = (tag: string, name: string): string | undefined =>
  tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

const favicon = (body: string): string => body.match(/<link[^>]*\srel="icon"[^>]*>/)?.[0] ?? '';

const brand = (body: string): string =>
  body.match(/<a[^>]*\sdata-brand(?=[\s>])[^>]*>[\s\S]*?<\/a>/)?.[0] ?? '';

test('given any dashboard page, when it is requested, then its header shows the Forge logo and wordmark linking to the Runs page, and the page declares the SVG logo as its favicon', async () => {
  const app = appWith({ logo: LOGO });

  for (const page of PAGES) {
    const body = await (await app.request(page)).text();
    const header = body.match(/<header[^>]*>[\s\S]*?<\/header>/)?.[0] ?? '';
    const link = brand(header);
    assert.equal(attribute(openingTag(link), 'href'), '/', `${page} should link the brand to the Runs page`);
    assert.equal(textOf(link), 'Forge', `${page} should show the Forge wordmark`);

    const logo = link.match(/<img[^>]*>/)?.[0] ?? '';
    const icon = favicon(body);
    assert.equal(attribute(icon, 'type'), 'image/svg+xml', `${page} should declare an SVG favicon`);
    assert.match(attribute(icon, 'href') ?? '', /^\/assets\/logo-[0-9a-f]{16,}\.svg$/);
    assert.equal(attribute(logo, 'src'), attribute(icon, 'href'), `${page} should show the favicon's logo in its header`);
  }
});

test('given the logo path the pages reference, when it is requested, then it returns the SVG logo with an immutable, long-lived cache header', async () => {
  const app = appWith({ logo: LOGO });
  const path = attribute(favicon(await (await app.request('/')).text()), 'href');

  const res = await app.request(path!);

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^image\/svg\+xml\b/);
  const cacheControl = (res.headers.get('cache-control') ?? '').split(/,\s*/);
  assert.ok(cacheControl.includes('immutable'), 'the logo should be cached as immutable');
  assert.equal(await res.text(), LOGO);

  const other = attribute(favicon(await (await appWith({ logo: `${LOGO} ` }).request('/')).text()), 'href');
  assert.notEqual(other, path, 'a different logo should get a different path');
});

test('given each dashboard page, when it is requested, then its title names the page followed by Forge', async () => {
  const app = appWith({});
  const titles: Record<(typeof PAGES)[number], string> = {
    '/': 'Workloads | Forge',
    '/runs/run-01': 'refiner | Forge',
    '/work': 'Frontier | Forge',
  };

  for (const page of PAGES) {
    const body = await (await app.request(page)).text();
    assert.equal(textOf(body.match(/<title>[\s\S]*?<\/title>/)?.[0] ?? ''), titles[page], `${page} should be titled ${titles[page]}`);
  }
});
