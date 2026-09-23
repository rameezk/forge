import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import type { HarnessEvent, RunRecord } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';

const sampleRun = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  id: 'run-01',
  worker: 'refiner',
  harness: 'pi',
  model: 'anthropic/claude-opus-4',
  startTime: '2026-09-21T10:00:00.000Z',
  endTime: '2026-09-21T10:03:20.000Z',
  status: 'success',
  costUncertain: false,
  costUsd: 0.1234,
  inputTokens: 4200,
  outputTokens: 850,
  transcriptRef: 'run-01.jsonl',
  sessionId: 'sess-abc',
  error: null,
  ...overrides,
});

const appWith = (runs: RunRecord[], dir: string = mkdtempSync(join(tmpdir(), 'forge-transcripts-'))) => {
  const store = Store.open(':memory:');
  for (const run of runs) store.insertRun(run);
  return createApp({ store, transcripts: new FileTranscriptSource(dir) });
};

test('given several finished runs, when the list is requested, then they render newest-first with a total cost', async () => {
  const app = appWith([
    sampleRun({ id: 'mid', worker: 'mid-worker', startTime: '2026-09-21T10:00:00.000Z', costUsd: 0.2 }),
    sampleRun({ id: 'newest', worker: 'newest-worker', startTime: '2026-09-21T11:00:00.000Z', costUsd: 0.1 }),
    sampleRun({ id: 'oldest', worker: 'oldest-worker', startTime: '2026-09-21T09:00:00.000Z', costUsd: 0.3 }),
  ]);

  const res = await app.request('/');
  assert.equal(res.status, 200);
  const body = await res.text();

  assert.ok(
    body.indexOf('newest-worker') < body.indexOf('mid-worker') &&
      body.indexOf('mid-worker') < body.indexOf('oldest-worker'),
    'workloads should render newest-first by start time',
  );
  assert.match(body, /anthropic\/claude-opus-4/);
  assert.match(body, /success/);
  assert.match(body, /\$0\.6000/, 'total cost tally should sum the runs');
});

test('given a cost-uncertain run beside a trusted one, when the list is requested, then only the uncertain run is marked', async () => {
  const app = appWith([
    sampleRun({ id: 'trusted', worker: 'trusted-worker', costUncertain: false }),
    sampleRun({ id: 'uncertain', worker: 'uncertain-worker', costUncertain: true }),
  ]);

  const body = await (await app.request('/')).text();

  assert.match(body, /class="run cost-uncertain"/, 'an uncertain run must carry a distinguishing marker');
  assert.match(body, />uncertain</, 'an uncertain run must show a visible badge');
});

test('given only trusted runs, when the list is requested, then no cost-uncertain marker appears', async () => {
  const app = appWith([sampleRun({ id: 'trusted', costUncertain: false })]);

  const body = await (await app.request('/')).text();

  assert.doesNotMatch(body, /class="run cost-uncertain"/);
  assert.doesNotMatch(body, />uncertain</);
});

test('given a run with a captured transcript, when its detail is requested, then its messages render', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-transcripts-'));
  const events: HarnessEvent[] = [
    { type: 'message', role: 'user', text: 'refine the spec please', usage: { inputTokens: 10, outputTokens: 0 }, costUsd: 0 },
    { type: 'message', role: 'assistant', text: 'here is the refined spec', usage: { inputTokens: 0, outputTokens: 20 }, costUsd: 0.01 },
    { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
  ];
  writeFileSync(join(dir, 'run-01.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const app = appWith([sampleRun({ id: 'run-01', transcriptRef: 'run-01.jsonl' })], dir);

  const res = await app.request('/runs/run-01');
  assert.equal(res.status, 200);
  const body = await res.text();

  assert.match(body, /refine the spec please/);
  assert.match(body, /here is the refined spec/);
});

test('given no such run, when its detail is requested, then the response is 404', async () => {
  const app = appWith([]);

  const res = await app.request('/runs/missing');
  assert.equal(res.status, 404);
});
