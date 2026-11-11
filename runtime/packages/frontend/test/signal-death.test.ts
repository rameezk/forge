import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, transcriptLine } from '@forge/shared';
import type { HarnessEvent, RunRecord } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { textOf } from './html.ts';

const ERROR = 'claude was killed by SIGTERM while tool call toolu_2 (Bash) was in flight';

const sampleRun = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  id: 'run-01',
  worker: 'builder',
  harness: 'claude-code',
  model: 'claude-opus-4-5',
  reasoningEffort: null,
  startTime: '2026-09-21T10:00:00.000Z',
  endTime: '2026-09-21T10:03:20.000Z',
  status: 'error',
  costStatus: 'billed',
  costUsd: 0.1234,
  costEstimated: false,
  unconfirmedEstimateUsd: 0,
  listPrice: null,
  inputTokens: 4200,
  outputTokens: 850,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  transcriptRef: 'run-01.jsonl',
  sessionId: null,
  error: ERROR,
  ticket: null,
  aliveAt: null,
  harnessStartTime: null,
  timeoutSeconds: null,
  maxCostUsd: null,
  exceededLimit: null,
  counters: null,
  ...overrides,
});

const call = (id: string, command: string): HarnessEvent => ({ type: 'tool_call', id, name: 'Bash', arguments: { command } });

const answer = (id: string): HarnessEvent => ({ type: 'tool_result', id, isError: false, text: 'ok' });

const died = (toolCallId: string | null, error: string): HarnessEvent => ({
  type: 'result',
  status: 'error',
  sessionId: null,
  error,
  signalDeath: { signal: 'SIGTERM', toolCallId },
});

const reasonOf = async (events: HarnessEvent[], run: Partial<RunRecord> = {}): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-transcripts-'));
  writeFileSync(join(dir, 'run-01.jsonl'), events.map(transcriptLine).join(''));
  const store = Store.open(':memory:');
  store.insertRun(sampleRun(run));
  const app = createApp({ store, transcripts: new FileTranscriptSource(dir), css: '', logo: '', idiomorph: '', client: '' });
  const body = await (await app.request('/runs/run-01')).text();
  return body.match(/<details[^>]*\sdata-reason[\s>][\s\S]*?<\/details>/)?.[0] ?? 'missing';
};

test('given a run whose harness died from a signal with a tool call in flight, when its run page is opened, then the error names the signal and links to that tool call in the transcript', async () => {
  const reason = await reasonOf([call('toolu_1', 'ls'), answer('toolu_1'), call('toolu_2', 'sleep 600'), died('toolu_2', ERROR)]);

  assert.match(textOf(reason), /claude was killed by SIGTERM while tool call toolu_2 \(Bash\) was in flight/);
  const link = reason.match(/<a[^>]*\sdata-signal-tool-call[\s>][^>]*>/)?.[0] ?? 'missing';
  assert.match(link, /href="\/runs\/run-01\/transcript#event-2"/);
});

test('given a run whose harness died from a signal between tool calls, when its run page is opened, then the error names the signal and links to no tool call', async () => {
  const reason = await reasonOf(
    [call('toolu_1', 'ls'), answer('toolu_1'), died(null, 'claude was killed by SIGTERM')],
    { error: 'claude was killed by SIGTERM' },
  );

  assert.match(textOf(reason), /claude was killed by SIGTERM/);
  assert.doesNotMatch(reason, /data-signal-tool-call/);
});

test('given a run whose harness died from a signal during a tool call inside a subagent, when its run page is opened, then the link goes to the subagent that holds the call', async () => {
  const inner: HarnessEvent = { type: 'tool_call', id: 'toolu_9', name: 'Bash', arguments: { command: 'sleep 600' }, subagent: 'toolu_1' };
  const reason = await reasonOf(
    [call('toolu_1', 'agent'), inner, died('toolu_9', 'claude was killed by SIGTERM while tool call toolu_9 (Bash) was in flight')],
    { error: 'claude was killed by SIGTERM while tool call toolu_9 (Bash) was in flight' },
  );

  const link = reason.match(/<a[^>]*\sdata-signal-tool-call[\s>][^>]*>/)?.[0] ?? 'missing';
  assert.match(link, /href="\/runs\/run-01\/transcript#event-0"/);
});
