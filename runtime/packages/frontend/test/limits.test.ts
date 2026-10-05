import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import type { RunRecord } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { openingTag, textOf } from './html.ts';

const sampleRun = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  id: 'run-01',
  worker: 'builder',
  harness: 'pi',
  model: 'anthropic/claude-opus-4',
  reasoningEffort: null,
  startTime: '2026-09-21T10:00:00.000Z',
  endTime: '2026-09-21T12:00:30.000Z',
  status: 'exceeded',
  costStatus: 'billed',
  costUsd: 0.1234,
  costEstimated: false,
  listPrice: null,
  inputTokens: 4200,
  outputTokens: 850,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  transcriptRef: null,
  sessionId: null,
  error: 'the workload was stopped after its timeout was exceeded',
  ticket: null,
  aliveAt: null,
  harnessStartTime: '2026-09-21T10:00:30.000Z',
  timeoutSeconds: 7200,
  exceededLimit: 'timeout',
  ...overrides,
});

const appWith = (setup: (store: Store) => void) => {
  const store = Store.open(':memory:');
  setup(store);
  return createApp({
    store,
    transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))),
    css: '',
    logo: '',
    idiomorph: '',
    client: '',
  });
};

const bodyOf = async (app: ReturnType<typeof appWith>, path: string): Promise<string> =>
  (await app.request(path)).text();

test('given a run that ended exceeded on a 2 hour timeout, when its page and the run list render, then each shows an amber exceeded pill and the page a callout naming the timeout', async () => {
  const app = appWith((store) => store.insertRun(sampleRun()));

  const page = await bodyOf(app, '/runs/run-01');
  const pill = page.match(/<span[^>]*\sdata-status="exceeded"[^>]*>[\s\S]*?<\/span>/)?.[0] ?? '';
  assert.match(pill, /bg-warning-soft text-warning/);
  assert.equal(textOf(pill), 'exceeded');
  const callout = page.match(/<p[^>]*\sdata-exceeded[^>]*>[\s\S]*?<\/p>/)?.[0] ?? '';
  assert.match(openingTag(callout), /bg-warning-soft/);
  assert.equal(textOf(callout), 'Stopped after 2h of a 2h timeout');

  const list = await bodyOf(app, '/');
  assert.match(list, /<span[^>]*\sdata-status="exceeded"[^>]*>\s*exceeded\s*<\/span>/);
});

test('given a dispatch that ended exceeded on its timeout, when the work page renders, then the dispatch reads Exceeded timeout beside a failed pill', async () => {
  const url = 'https://github.com/rameezk/forge/issues/56';
  const app = appWith((store) => {
    store.replaceFrontier({
      repository: 'forge',
      github: 'rameezk/forge',
      polledAt: '2026-09-29T08:15:00.000Z',
      tickets: [{ number: 56, title: 'Slow ticket', url, parent: null, createdAt: '2026-09-28T10:00:00Z', forgeReady: false, blocked: false }],
    });
    const start = store.startDispatch({ repository: 'forge', number: 56, url }, 'run-56', '2026-09-29T08:00:00.000Z', Number.POSITIVE_INFINITY);
    assert.ok('started' in start);
    store.endDispatch(start.started, { state: 'failed', reason: 'exceeded', detail: 'timeout' }, '2026-09-29T10:00:00.000Z');
  });

  const cell = (await bodyOf(app, '/work')).match(/<td[^>]*\sdata-dispatch="failed"[^>]*>[\s\S]*?<\/td>/)?.[0] ?? '';

  assert.match(textOf(cell), /failed .*Exceeded timeout$/);
  assert.doesNotMatch(textOf(cell), /Exceeded: /);
});

test('given a running run with a 2 hour timeout whose harness started after its run did, and one with no timeout, when the list and run pages render, then the first carries the harness start and its timeout for the browser to count against and the second counts from its run start', async () => {
  const running = { status: 'running', endTime: null, costStatus: 'pending', exceededLimit: null, error: null } as const;
  const app = appWith((store) => {
    store.insertRun(sampleRun({ id: 'limited', ...running }));
    store.insertRun(sampleRun({ id: 'open', ...running, timeoutSeconds: null, harnessStartTime: null }));
  });

  const counting = (body: string): string =>
    body.match(/<span[^>]*\sdata-elapsed-since="[^"]*"[^>]*>/)?.[0] ?? '';
  const limited = await bodyOf(app, '/runs/limited');
  assert.match(counting(limited), /data-elapsed-since="2026-09-21T10:00:30.000Z"/);
  assert.match(counting(limited), /data-elapsed-limit="2h"/);
  assert.match(counting(await bodyOf(app, '/')), /data-elapsed-since="2026-09-21T10:00:30.000Z"/);
  const open = counting(await bodyOf(app, '/runs/open'));
  assert.match(open, /data-elapsed-since="2026-09-21T10:00:00.000Z"/);
  assert.doesNotMatch(open, /data-elapsed-limit/);
});
