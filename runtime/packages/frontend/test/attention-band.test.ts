import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import type { RunRecord } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import type { DeployStatus } from '../src/index.ts';
import { openingTag, textOf } from './html.ts';

const RUNNING = '1111111111111111111111111111111111111111';

const status = (overrides: Partial<DeployStatus> = {}): DeployStatus => ({
  running: RUNNING,
  head: RUNNING,
  error: null,
  bumpError: null,
  forge: null,
  upstream: null,
  upstreamHead: null,
  behind: null,
  ...overrides,
});

const run: RunRecord = {
  id: 'run-01',
  worker: 'refiner',
  harness: 'pi',
  model: 'anthropic/claude-opus-4',
  reasoningEffort: null,
  startTime: '2026-09-21T10:00:00.000Z',
  endTime: '2026-09-21T10:05:00.000Z',
  status: 'success',
  costStatus: 'billed',
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
  ticket: null,
  aliveAt: null,
  harnessStartTime: null,
  timeoutSeconds: null,
  maxCostUsd: null,
  exceededLimit: null,
  counters: null,
};

const PAGES = ['/', '/workloads', '/insights', '/runs/run-01'];

const pageWith = async (page: string, deployStatus: DeployStatus | null): Promise<string> => {
  const store = Store.open(':memory:');
  store.insertRun(run);
  const app = createApp({
    store,
    transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))),
    css: '',
    logo: '',
    idiomorph: '',
    client: '',
    deployStatus: () => deployStatus,
  });
  const response = await app.request(page);
  assert.equal(response.status, 200, page);
  return response.text();
};

const bandOf = (body: string): string | undefined => body.match(/<[^>]*\sdata-attention-band[^>]*>[\s\S]*?<\/section>/)?.[0];

const rowOf = (band: string, marker: string): string | undefined => band.match(new RegExp(`<[^>]*\\s${marker}[^>]*>[\\s\\S]*?</p>`))?.[0];

test('given a forge bump error, when the Board, Workloads, Insights and a run page are requested, then each shows the bump error in the band under the menu bar', async () => {
  for (const page of PAGES) {
    const body = await pageWith(page, status({ bumpError: 'Resource not accessible by integration' }));

    const band = bandOf(body);
    assert.ok(band, page);
    assert.match(textOf(rowOf(band, 'data-bump-error') ?? ''), /^Forge bump: Resource not accessible by integration$/, page);
    assert.ok(body.indexOf('</header>') < body.indexOf('data-attention-band'), page);
    assert.ok(body.indexOf('data-attention-band') < body.indexOf('<main'), page);
  }
});

test('given a deploy error and a bump error, when the Board is requested, then each appears once, in the band, and not above the lanes', async () => {
  const body = await pageWith('/', status({ error: 'building the system failed', bumpError: 'dispatch refused' }));

  assert.equal(textOf(body).match(/building the system failed/g)?.length, 1);
  assert.equal(textOf(body).match(/dispatch refused/g)?.length, 1);
  const band = bandOf(body);
  assert.ok(band);
  assert.match(textOf(rowOf(band, 'data-deploy-error') ?? ''), /building the system failed/);
  assert.match(textOf(rowOf(band, 'data-bump-error') ?? ''), /dispatch refused/);
  const main = body.slice(body.indexOf('<main'));
  assert.doesNotMatch(main, /data-deploy-error|data-bump-error/);
});

test('given no deploy error and no bump error, when any page is requested, then there is no band', async () => {
  for (const deployStatus of [null, status()]) {
    for (const page of PAGES) {
      assert.doesNotMatch(await pageWith(page, deployStatus), /data-attention-band/, page);
    }
  }
});

test('given a deploy error, when the Workloads page is requested, then the deploy failed link targets the row in the band on the same page', async () => {
  const body = await pageWith('/workloads', status({ error: 'building the system failed' }));

  const pill = /<a\s[^>]*\bdata-deploy-failed\b[^>]*>/.exec(body)?.[0] ?? '';
  assert.equal(/\shref="([^"]*)"/.exec(pill)?.[1], '#deploy-error');
  const row = rowOf(bandOf(body) ?? '', 'data-deploy-error');
  assert.ok(row);
  assert.match(openingTag(row), /\sid="deploy-error"/);
});

test('given a bump error with markup and a long multi-line deploy error, when a page is requested, then the rows are escaped and wrap', async () => {
  const body = await pageWith('/workloads', status({ error: 'line one\nline two', bumpError: '<script>alert(1)</script>' }));

  assert.doesNotMatch(body, /<script>alert/);
  const band = bandOf(body) ?? '';
  assert.match(band, /&lt;script&gt;/);
  for (const marker of ['data-deploy-error', 'data-bump-error']) {
    const tag = openingTag(rowOf(band, marker) ?? '');
    assert.match(tag, /whitespace-pre-line/, marker);
    assert.match(tag, /break-words/, marker);
    assert.match(tag, /bg-error-soft/, marker);
    assert.doesNotMatch(tag, /\struncate\b|line-clamp/, marker);
  }
});
