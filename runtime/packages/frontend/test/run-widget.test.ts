import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, transcriptLine } from '@forge/shared';
import type { HarnessEvent, RunRecord } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { openingTag, textOf } from './html.ts';

const sampleRun = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  id: 'run-01',
  worker: 'builder',
  harness: 'pi',
  model: 'z-ai/glm-5',
  reasoningEffort: null,
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
  transcriptRef: 'run-01.jsonl',
  sessionId: null,
  error: null,
  ticket: null,
  aliveAt: null,
  harnessStartTime: null,
  timeoutSeconds: null,
  maxCostUsd: null,
  exceededLimit: null,
  counters: null,
  ...overrides,
});

const usage = { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

const say = (text: string, timestamp?: string): HarnessEvent =>
  ({ type: 'message', role: 'assistant', text, usage, generationId: null, ...(timestamp === undefined ? {} : { timestamp }) }) as HarnessEvent;

const think = (thinking: string): HarnessEvent =>
  ({ type: 'message', role: 'assistant', text: '', thinking, usage, generationId: null }) as HarnessEvent;

const call = (id: string, command: string): HarnessEvent => ({ type: 'tool_call', id, name: 'bash', arguments: { command } });

const answer = (id: string, text: string, isError = false): HarnessEvent => ({ type: 'tool_result', id, isError, text });

const runPage = async (events: HarnessEvent[], run: Partial<RunRecord> = {}): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-transcripts-'));
  writeFileSync(join(dir, 'run-01.jsonl'), events.map(transcriptLine).join(''));
  const store = Store.open(':memory:');
  store.insertRun(sampleRun(run));
  const app = createApp({ store, transcripts: new FileTranscriptSource(dir), css: '', logo: '', idiomorph: '', client: '' });
  return (await (await app.request('/runs/run-01')).text());
};

const widget = (body: string): string => body.match(/<section[^>]*\sdata-widget[\s>][\s\S]*?<\/section>/)?.[0] ?? '';

const rows = (body: string): string[] => widget(body).match(/<li[^>]*\sdata-widget-row[\s>][\s\S]*?<\/li>/g) ?? [];

const link = (body: string, attribute: string): string =>
  widget(body).match(new RegExp(`<a[^>]*\\s${attribute}[\\s>][\\s\\S]*?</a>`))?.[0] ?? '';

test('given a workload with more than 50 transcript events, when its run page is opened, then the widget lists the latest 50 newest first and the full transcript is not rendered', async () => {
  const events = Array.from({ length: 60 }, (_, index) => say(`step ${index + 1}`));

  const body = await runPage(events);

  const listed = rows(body).map((row) => textOf(row));
  assert.equal(listed.length, 50);
  assert.match(listed[0]!, /step 60/);
  assert.match(listed[49]!, /step 11/);
  assert.doesNotMatch(body, /data-transcript=|data-message=/);
});

test('given a transcript of messages, thinking and tool calls, when its run page is opened, then each row shows its kind, a one-line summary and the time when known, and failed tool calls carry an error badge', async () => {
  const body = await runPage([
    say('Looking at the build.\nSecond line.', '2026-09-21T10:00:05.000Z'),
    think('Weighing the options\nmore thought'),
    call('c1', 'echo fine'),
    answer('c1', 'fine'),
    call('c2', 'cat missing'),
    answer('c2', 'no such file', true),
  ]);

  const [failedCall, okCall, thinking, message] = rows(body);
  assert.equal(textOf(failedCall!), 'tool bash cat missing error');
  assert.match(failedCall!, /data-badge="error"/);
  assert.equal(textOf(okCall!), 'tool bash echo fine');
  assert.doesNotMatch(okCall!, /data-badge="error"/);
  assert.equal(textOf(thinking!), 'thinking Weighing the options');
  assert.equal(textOf(message!), '10:00:05 assistant Looking at the build.');
});

test('given a workload with a failed tool call, when the widget links are read, then Expand opens the full transcript, First error its errors filter and the failed row its event', async () => {
  const body = await runPage([say('hi'), call('c1', 'cat missing'), answer('c1', 'no such file', true)]);

  assert.match(openingTag(link(body, 'data-widget-expand')), /href="\/runs\/run-01\/transcript"/);
  assert.match(openingTag(link(body, 'data-widget-first-error')), /href="\/runs\/run-01\/transcript\?show=errors"/);
  const failed = rows(body)[0]!;
  assert.match(openingTag(failed.match(/<a[^>]*>/)?.[0] ?? ''), /href="\/runs\/run-01\/transcript#event-1"/);
});

test('given a workload with no failed tool calls, when its run page is opened, then the widget has no First error link', async () => {
  const body = await runPage([say('hi'), call('c1', 'echo fine'), answer('c1', 'fine')]);

  assert.equal(link(body, 'data-widget-first-error'), '');
  assert.notEqual(link(body, 'data-widget-expand'), '');
});

test('given a workload with no transcript, when its run page is opened, then the widget says none was captured', async () => {
  const body = await runPage([], { transcriptRef: null });

  assert.equal(rows(body).length, 0);
  assert.match(textOf(widget(body)), /No transcript captured\./);
});
