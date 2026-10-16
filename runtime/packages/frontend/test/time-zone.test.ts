import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import type { HarnessEvent, RunRecord, Ticket } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { textOf } from './html.ts';

const JOHANNESBURG = 'Africa/Johannesburg';

const TICKET = { repository: 'forge', number: 42, url: 'https://github.com/rameezk/forge/issues/42' };

const usage = { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

const run: RunRecord = {
  id: 'run-01',
  worker: 'refiner',
  harness: 'pi',
  model: 'anthropic/claude-opus-4',
  reasoningEffort: null,
  startTime: '2026-10-14T23:30:00.000Z',
  endTime: '2026-10-14T23:33:20.000Z',
  status: 'success',
  costStatus: 'billed',
  costUsd: 0.1234,
  costEstimated: false,
  listPrice: null,
  inputTokens: 4200,
  outputTokens: 850,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  transcriptRef: 'run-01.jsonl',
  sessionId: 'sess-abc',
  error: null,
  ticket: TICKET,
  aliveAt: null,
  harnessStartTime: null,
  timeoutSeconds: null,
  maxCostUsd: null,
  exceededLimit: null,
  counters: null,
};

const events: HarnessEvent[] = [
  { type: 'message', role: 'user', text: 'go', timestamp: '2026-10-03T11:30:57.948Z', usage, generationId: null },
  { type: 'message', role: 'assistant', text: 'done', timestamp: '2026-10-03T11:30:58.077Z', stopReason: 'stop', usage, generationId: null },
  { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
];

const ticket: Ticket = {
  number: 7,
  title: 'A ticket',
  url: 'https://github.com/rameezk/forge/issues/7',
  parent: null,
  createdAt: '2026-09-29T23:30:00Z',
  forgeReady: false,
  blocked: false,
};

const dashboard = (timeZone?: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-transcripts-'));
  writeFileSync(join(dir, 'run-01.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  const store = Store.open(':memory:');
  store.insertRun(run);
  const started = store.startDispatch(TICKET, run.id, run.startTime, 100);
  assert.ok('started' in started);
  store.endDispatch(started.started, { state: 'failed', reason: 'no-pull-request', detail: null }, run.endTime!);
  store.replaceFrontier({ repository: 'forge', github: 'rameezk/forge', polledAt: '2026-09-29T23:15:00.000Z', tickets: [ticket] });
  store.recordFrontierError({ repository: 'dotfiles', github: 'rameezk/dotfiles', message: 'boom', failedAt: '2026-09-29T23:20:00.000Z' });
  const app = createApp({
    store,
    transcripts: new FileTranscriptSource(dir),
    css: '',
    logo: '',
    idiomorph: '',
    client: '',
    ...(timeZone === undefined ? {} : { timeZone }),
  });
  return async (path: string): Promise<string> => (await app.request(path)).text();
};

const PAGES = ['/', '/runs', '/insights', '/runs/run-01', '/runs/run-01/transcript', '/tickets/forge/42'] as const;

const footerOf = (body: string): string => textOf(body.match(/<footer[\s\S]*?<\/footer>/)?.[0] ?? 'missing');

test('given a run that started at 2026-10-14T23:30:00Z and a display time zone of Africa/Johannesburg, when the runs list and run page are requested, then the start reads 2026-10-15 01:30:00 with no suffix and the time element keeps the UTC instant', async () => {
  const get = dashboard(JOHANNESBURG);
  const started = /<time datetime="2026-10-14T23:30:00\.000Z" title="2026-10-14T23:30:00\.000Z"[^>]*>2026-10-15 01:30:00<\/time>/;

  assert.match(await get('/runs'), started);
  assert.match(await get('/runs/run-01'), started);
});

test('given no display time zone, when the runs list is requested, then the start reads in UTC with no suffix', async () => {
  const body = await dashboard()('/runs');

  assert.match(body, /<time datetime="2026-10-14T23:30:00\.000Z"[^>]*>2026-10-14 23:30:00<\/time>/);
  assert.doesNotMatch(body, /\bUTC<\/time>/);
});

test('given a transcript entry at 11:30:57Z and a display time zone of Africa/Johannesburg, when the run page and full transcript are requested, then the entry reads 13:30:57 with the UTC instant kept', async () => {
  const get = dashboard(JOHANNESBURG);

  for (const page of ['/runs/run-01', '/runs/run-01/transcript']) {
    const body = await get(page);
    assert.match(body, /<time datetime="2026-10-03T11:30:57\.948Z" title="2026-10-03T11:30:57\.948Z"[^>]*>13:30:57<\/time>/, page);
  }
});

test('given a frontier last polled at 2026-09-29T23:15:00Z, a failed poll at 23:20:00Z, and a ticket created at 23:30:00Z, when the Board is requested in Africa/Johannesburg, then each reads in local time', async () => {
  const body = await dashboard(JOHANNESBURG)('/');

  assert.match(body, /Last polled <time datetime="2026-09-29T23:15:00\.000Z"[^>]*>2026-09-30 01:15:00<\/time>/);
  assert.match(body, /Last poll failed <time datetime="2026-09-29T23:20:00\.000Z"[^>]*>2026-09-30 01:20:00<\/time>/);
  assert.match(body, /<time datetime="2026-09-29T23:30:00Z"[^>]*>2026-09-30<\/time>/);
});

test('given a run that started at 2026-10-14T23:30:00Z and Africa/Johannesburg, when the ticket attempts page is requested, then the run label uses the local date', async () => {
  const body = await dashboard(JOHANNESBURG)('/tickets/forge/42');

  assert.match(body, /data-field="run"[\s\S]*?<time datetime="2026-10-14T23:30:00\.000Z"[^>]*>2026-10-15<\/time>/);
});

test('given no display time zone, when any page is requested, then its footer reads Times in UTC', async () => {
  const get = dashboard();

  for (const page of PAGES) assert.equal(footerOf(await get(page)), 'Times in UTC', page);
});

test('given Africa/Johannesburg, when any page is requested, then its footer reads Times in Africa/Johannesburg in the page width container with a top border, muted', async () => {
  const get = dashboard(JOHANNESBURG);

  for (const page of PAGES) {
    const body = await get(page);
    assert.equal(footerOf(body), 'Times in Africa/Johannesburg', page);
    assert.match(body, /<footer[^>]*class="[^"]*\bborder-t\b[^"]*\btext-muted\b[^"]*"/, page);
    assert.match(body, /<footer[\s\S]*?<div[^>]*class="[^"]*max-w-\[100rem\][^"]*"/, page);
  }
});
