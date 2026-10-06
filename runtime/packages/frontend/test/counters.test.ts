import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import type { RunCounters, RunRecord } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { textOf } from './html.ts';

const sampleRun = (id: string, counters: RunCounters | null): RunRecord => ({
  id,
  worker: 'builder',
  harness: 'pi',
  model: 'anthropic/claude-sonnet-5.5',
  reasoningEffort: 'high',
  startTime: '2026-09-21T10:00:00.000Z',
  endTime: '2026-09-21T10:03:00.000Z',
  status: 'success',
  costStatus: 'billed',
  costUsd: 0.1,
  costEstimated: false,
  listPrice: null,
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  transcriptRef: null,
  sessionId: null,
  error: null,
  ticket: null,
  aliveAt: null,
  harnessStartTime: null,
  timeoutSeconds: null,
  exceededLimit: null,
  counters,
  maxCostUsd: null,
});

const counted = async (counters: RunCounters | null): Promise<Record<string, string>> => {
  const store = Store.open(':memory:');
  store.insertRun(sampleRun('run', counters));
  const app = createApp({
    store,
    transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))),
    css: '',
    logo: '',
    idiomorph: '',
    client: '',
  });
  const page = await (await app.request('/runs/run')).text();
  return Object.fromEntries(
    ['tool-calls', 'failed-tool-results', 'retries', 'compactions'].flatMap((name) => {
      const cell = page.match(new RegExp(`<dd[^>]*\\sdata-${name}[^>]*>[\\s\\S]*?</dd>`))?.[0];
      return cell === undefined ? [] : [[name, textOf(cell)]];
    }),
  );
};

test('given a workload with counters, when its run detail page is requested, then the summary shows its tool calls, failed tool results, retries and compactions', async () => {
  assert.deepEqual(
    await counted({ toolCalls: 12, failedToolResults: 3, retries: 2, compactions: 1 }),
    { 'tool-calls': '12', 'failed-tool-results': '3', retries: '2', compactions: '1' },
  );
});

test('given a workload without counters, when its run detail page is requested, then the summary shows none', async () => {
  assert.deepEqual(await counted(null), {});
});
