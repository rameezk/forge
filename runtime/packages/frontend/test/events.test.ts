import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store, transcriptLine } from '@forge/shared';
import type { HarnessEvent, LookupResult, RunRecord } from '@forge/shared';
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
  costEstimated: false,
  listPrice: null,
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
  const transcriptsDir = join(stateDir, 'transcripts');
  mkdirSync(transcriptsDir);
  const app = createApp({
    store: reader,
    transcripts: new FileTranscriptSource(transcriptsDir),
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
  const appendEvent = (ref: string, event: HarnessEvent) => appendFileSync(join(transcriptsDir, ref), transcriptLine(event));
  const writeTranscript = (ref: string) => writeFileSync(join(transcriptsDir, ref), '');
  return { app, writer, appendEvent, writeTranscript };
};

const message = (text: string): HarnessEvent => ({
  type: 'message',
  role: 'assistant',
  text,
  usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  generationId: null,
});

const runningRun = sampleRun({ status: 'running', endTime: null, costStatus: 'pending', costUsd: 0, transcriptRef: 'run-01.jsonl' });

type ServerEvent = { event: string; data: string };

const streamEvents = async (t: TestContext, app: ReturnType<typeof createApp>, page: string) => {
  const res = await app.request(`/events?page=${encodeURIComponent(page)}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream\b/);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  t.after(() => reader.cancel());
  let buffer = '';
  const next = async (): Promise<ServerEvent | null> => {
    let end = buffer.indexOf('\n\n');
    while (end === -1) {
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += value;
      end = buffer.indexOf('\n\n');
    }
    const fields = new Map(
      buffer
        .slice(0, end)
        .split('\n')
        .map((line) => {
          const colon = line.indexOf(':');
          return [line.slice(0, colon), line.slice(colon + 1).replace(/^ /, '')] as const;
        }),
    );
    buffer = buffer.slice(end + 2);
    return { event: fields.get('event') ?? 'message', data: fields.get('data') ?? '' };
  };
  const connected = await next();
  const nextWithin = (checks: number): Promise<ServerEvent | null | 'quiet'> =>
    Promise.race([next(), sleep(checks * CHECK_INTERVAL_MS).then(() => 'quiet' as const)]);
  return { connected, next, nextWithin };
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
    estimatedCostUsd: null,
    createdAt: '2026-09-21T10:01:00.000Z',
  });

  assert.equal(await stream.nextWithin(40), 'quiet');
});

test('given a client opening a page\'s stream, when it connects, then the stream emits a change signal at once, so the client catches up with any write since it loaded the page', async (t) => {
  const { app } = dashboard(t);

  const stream = await streamEvents(t, app, '/');

  assert.equal(stream.connected?.event, 'change');
});

test('given a page that does not update live, when its events are requested, then they are not found', async (t) => {
  const { app } = dashboard(t);

  for (const page of ['/runs/run-01', '/runs/%E0%A4%A', '/events', '/assets/x.css', '']) {
    const res = await app.request(`/events?page=${encodeURIComponent(page)}`);
    assert.equal(res.status, 404, `${page} should have no event stream`);
  }
  assert.equal((await app.request('/events')).status, 404);
});

test('given a client streaming events for a running workload\'s detail page, when an event is appended to its transcript, then the stream emits a change signal', async (t) => {
  const { app, writer, appendEvent, writeTranscript } = dashboard(t);
  writer.insertRun(runningRun);
  writeTranscript('run-01.jsonl');
  const stream = await streamEvents(t, app, '/runs/run-01');

  appendEvent('run-01.jsonl', message('Reading the ticket.'));

  const signal = await stream.next();
  assert.equal(signal?.event, 'change');
});

const generation = {
  runId: 'run-01',
  generationId: 'gen-01',
  subagent: null,
  usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  estimatedCostUsd: null,
  createdAt: '2026-09-21T10:01:00.000Z',
};

const ended = { status: 'success', endTime: '2026-09-21T10:03:20.000Z', sessionId: 'sess-abc', error: null } as const;

const settlements: [string, (id: number) => LookupResult][] = [
  ['billed', (id) => ({ id, billing: { costUsd: 0.25, usage: null, reasoningTokens: null, provider: 'Anthropic' } })],
  ['unconfirmed', (id) => ({ id, error: 'not found', givenUp: true })],
];

for (const [costStatus, lookup] of settlements) {
  test(`given a client streaming events for a workload's detail page, when the workload has ended and its cost status becomes ${costStatus}, then the stream emits done and closes`, async (t) => {
    const { app, writer, writeTranscript } = dashboard(t);
    writer.insertRun(runningRun);
    writeTranscript('run-01.jsonl');
    writer.recordGeneration(generation);
    writer.finalizeRun('run-01', ended);
    const stream = await streamEvents(t, app, '/runs/run-01');

    const [unsettled] = writer.unsettledGenerations();
    writer.recordLookups([lookup(unsettled!.id)], '2026-09-21T10:05:00.000Z');

    let signal = await stream.next();
    while (signal?.event === 'change') signal = await stream.next();
    assert.equal(signal?.event, 'done');
    assert.equal(await stream.next(), null);
  });
}

test('given a client streaming events for a workload that has ended with cost status pending, when a check runs, then the stream stays open', async (t) => {
  const { app, writer, writeTranscript } = dashboard(t);
  writer.insertRun(runningRun);
  writeTranscript('run-01.jsonl');
  writer.recordGeneration(generation);
  writer.finalizeRun('run-01', ended);
  const stream = await streamEvents(t, app, '/runs/run-01');

  const signal = await stream.nextWithin(40);

  assert.equal(signal, 'quiet');
});
