import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store } from '@forge/shared';
import type { RunRecord } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';

const CHECK_INTERVAL_MS = 5;

const sampleRun = (overrides: Partial<RunRecord> = {}): RunRecord => ({
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
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  transcriptRef: null,
  sessionId: 'sess-abc',
  error: null,
  ticket: null,
  ...overrides,
});

const dashboard = (t: TestContext) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'forge-events-'));
  const path = join(stateDir, 'forge.db');
  const writer = Store.open(path);
  const reader = Store.open(path);
  const app = createApp({
    store: reader,
    transcripts: new FileTranscriptSource(join(stateDir, 'transcripts')),
    css: '',
    logo: '',
    idiomorph: '',
    client: '',
    checkIntervalMs: CHECK_INTERVAL_MS,
  });
  t.after(() => {
    writer.close();
    reader.close();
    rmSync(stateDir, { recursive: true, force: true });
  });
  return { app, writer };
};

type ServerEvent = { event: string; data: string };

const streamEvents = async (
  t: TestContext,
  app: ReturnType<typeof createApp>,
  page: string,
  lastEventId?: string,
) => {
  const res = await app.request(`/events?page=${encodeURIComponent(page)}`, {
    headers: lastEventId === undefined ? {} : { 'Last-Event-ID': lastEventId },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream\b/);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const close = () => reader.cancel();
  t.after(close);
  let buffer = '';
  let id: string | undefined;
  const queued: ServerEvent[] = [];
  const readBlock = async (): Promise<boolean> => {
    let end = buffer.indexOf('\n\n');
    while (end === -1) {
      const { value, done } = await reader.read();
      if (done) return false;
      buffer += value;
      end = buffer.indexOf('\n\n');
    }
    const fields = buffer
      .slice(0, end)
      .split('\n')
      .map((line) => {
        const colon = line.indexOf(':');
        return [line.slice(0, colon), line.slice(colon + 1).replace(/^ /, '')] as const;
      });
    buffer = buffer.slice(end + 2);
    const field = (name: string) => fields.find(([key]) => key === name)?.[1];
    id = field('id') ?? id;
    const data = field('data');
    if (data !== undefined) queued.push({ event: field('event') ?? 'message', data });
    return true;
  };
  while (id === undefined) {
    if (!(await readBlock())) throw new Error('the event stream ended before it was connected');
  }
  const next = async (): Promise<ServerEvent | null> => {
    while (queued.length === 0) {
      if (!(await readBlock())) return null;
    }
    return queued.shift()!;
  };
  const nextWithin = (checks: number): Promise<ServerEvent | null | 'quiet'> =>
    Promise.race([next(), sleep(checks * CHECK_INTERVAL_MS).then(() => 'quiet' as const)]);
  return { next, nextWithin, close, lastEventId: () => id! };
};

test('given a client streaming events for the runs list, when a new run is recorded in the store, then the stream emits a change signal', async (t) => {
  const { app, writer } = dashboard(t);
  const stream = await streamEvents(t, app, '/');

  writer.insertRun(sampleRun());

  const signal = await stream.next();
  assert.equal(signal?.event, 'change');
});

test('given a client streaming events for the work page, when a generation is recorded for a running workload, then no change signal is emitted', async (t) => {
  const { app, writer } = dashboard(t);
  writer.insertRun(sampleRun({ status: 'running', endTime: null, costStatus: 'pending', costUsd: 0 }));
  const stream = await streamEvents(t, app, '/work');

  writer.recordGeneration({
    runId: 'run-01',
    generationId: 'gen-01',
    subagent: null,
    usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    createdAt: '2026-09-21T10:01:00.000Z',
  });

  assert.equal(await stream.nextWithin(40), 'quiet');
});

test('given a client whose stream dropped, when it reconnects after the page changed, then the stream emits a change signal at once, and when it reconnects with the page unchanged, then it does not', async (t) => {
  const { app, writer } = dashboard(t);
  const dropped = await streamEvents(t, app, '/');
  await dropped.close();

  writer.insertRun(sampleRun());
  const stale = await streamEvents(t, app, '/', dropped.lastEventId());
  assert.equal((await stale.next())?.event, 'change');
  await stale.close();

  const current = await streamEvents(t, app, '/', stale.lastEventId());
  assert.equal(await current.nextWithin(40), 'quiet');
});

test('given a page that does not update live, when its events are requested, then they are not found', async (t) => {
  const { app } = dashboard(t);

  for (const page of ['/runs/run-01', '/events', '/assets/x.css', '']) {
    const res = await app.request(`/events?page=${encodeURIComponent(page)}`);
    assert.equal(res.status, 404, `${page} should have no event stream`);
  }
  assert.equal((await app.request('/events')).status, 404);
});
