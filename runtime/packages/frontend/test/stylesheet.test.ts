import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';

const appWith = (css: string) => {
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
  });
};

const PAGES = ['/', '/runs/run-01', '/work'];

const stylesheetLinks = (body: string): string[] =>
  [...body.matchAll(/<link[^>]*\srel="stylesheet"[^>]*>/g)].map(
    ([link]) => link.match(/\shref="([^"]*)"/)?.[1] ?? '',
  );

test('given any dashboard page, when it is requested, then it links exactly one stylesheet under a content-hashed path and contains no inline style', async () => {
  const first = appWith('body { color: red; }');
  const second = appWith('body { color: blue; }');

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
  const app = appWith(css);
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
