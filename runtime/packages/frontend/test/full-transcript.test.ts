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
  worker: 'refiner',
  harness: 'pi',
  model: 'anthropic/claude-opus-4',
  reasoningEffort: null,
  startTime: '2026-09-21T10:00:00.000Z',
  endTime: '2026-09-21T10:03:20.000Z',
  status: 'success',
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
  sessionId: 'sess-abc',
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

const message = (text: string, extra: Partial<HarnessEvent> = {}): HarnessEvent =>
  ({ type: 'message', role: 'assistant', text, usage, generationId: null, ...extra }) as HarnessEvent;

const call = (id: string, command: string, subagent?: string): HarnessEvent =>
  ({ type: 'tool_call', id, name: 'bash', arguments: { command }, ...(subagent === undefined ? {} : { subagent }) }) as HarnessEvent;

const answer = (id: string, text: string, isError = false, subagent?: string): HarnessEvent =>
  ({ type: 'tool_result', id, isError, text, ...(subagent === undefined ? {} : { subagent }) }) as HarnessEvent;

const finished: HarnessEvent = { type: 'result', status: 'success', sessionId: 'sess-abc', error: null };

const mixed: HarnessEvent[] = [
  { type: 'message', role: 'user', text: 'fix the build', usage, generationId: null },
  message('looking'),
  call('c1', 'echo one'),
  answer('c1', 'one'),
  call('c2', 'cat missing'),
  answer('c2', 'no such file', true),
  call('c3', 'make build'),
  answer('c3', 'broke', true),
  call('sub', 'delegate'),
  message('child work', { subagent: 'sub' }),
  answer('sub', 'child report'),
  message('done'),
  finished,
];

const appWith = (events: HarnessEvent[], run: Partial<RunRecord> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-transcripts-'));
  writeFileSync(join(dir, 'run-01.jsonl'), events.map(transcriptLine).join(''));
  const store = Store.open(':memory:');
  store.insertRun(sampleRun(run));
  return createApp({ store, transcripts: new FileTranscriptSource(dir), css: '', logo: '', idiomorph: '', client: '' });
};

const pageOf = async (events: HarnessEvent[], path = '/runs/run-01/transcript'): Promise<string> => {
  const response = await appWith(events).request(path);
  assert.equal(response.status, 200);
  return response.text();
};

const idsOf = (body: string): string[] =>
  [...body.matchAll(/<[a-z]+[^>]*\sdata-event-anchor="([^"]+)"/g)].map((match) => match[1] ?? '');

const toolCards = (body: string): string[] =>
  body.match(/<details[^>]*\sdata-tool-call[\s>][\s\S]*?<\/details>/g) ?? [];

test('given a run with a transcript, when its full transcript page is opened, then its events are listed in time order with a link back to the run page', async () => {
  const body = await pageOf(mixed);

  const order = ['fix the build', 'looking', 'echo one', 'cat missing', 'make build', 'child work', 'done'].map((part) => body.indexOf(part));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(order.every((index) => index >= 0));
  const back = body.match(/<a[^>]*\sdata-back-to-run[^>]*>[\s\S]*?<\/a>/)?.[0] ?? '';
  assert.match(back, /\shref="\/runs\/run-01"/);
});

test('given no run with the requested id, when its full transcript page is requested, then the dashboard answers not found', async () => {
  const response = await appWith(mixed).request('/runs/nope/transcript');

  assert.equal(response.status, 404);
});

test('given a run with failed and successful tool calls, when its full transcript page is opened, then every tool call starts collapsed and failed ones are marked', async () => {
  const cards = toolCards(await pageOf(mixed));

  assert.equal(cards.length, 3);
  for (const card of cards) assert.doesNotMatch(openingTag(card), /\sopen[\s>]/);
  const failed = cards.filter((card) => /\sdata-failed[\s>]/.test(openingTag(card)));
  assert.equal(failed.length, 2);
  for (const card of failed) {
    assert.match(openingTag(card), /border-error/);
    assert.match(card, /<span[^>]*text-error[^>]*\sdata-tool-name[\s>]/);
    assert.match(card, /<span[^>]*\sdata-badge="error"[^>]*>error<\/span>/);
  }
});

test('given a run with a transcript, when its run page is opened, then it links to the full transcript page and the download no longer sits on that address', async () => {
  const app = appWith(mixed);

  const page = await (await app.request('/runs/run-01')).text();
  const link = page.match(/<a[^>]*\sdata-widget-expand[^>]*>/)?.[0] ?? '';
  const download = page.match(/<a[^>]*\sdata-download="transcript.jsonl"[^>]*>/)?.[0] ?? '';

  assert.match(link, /\shref="\/runs\/run-01\/transcript"/);
  const href = download.match(/\shref="([^"]+)"/)?.[1] ?? '';
  assert.notEqual(href, '/runs/run-01/transcript');
  const served = await app.request(href);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
});


const FILTER_LABELS = ['All', 'Messages', 'Tool calls', 'Errors', 'Subagents'];

const railOf = (body: string): { label: string; count: string; selected: boolean; href: string }[] =>
  (body.match(/<a[^>]*\sdata-filter="[^"]*"[^>]*>[\s\S]*?<\/a>/g) ?? []).map((link) => ({
    label: textOf(link).replace(/\s*\d+$/, ''),
    count: link.match(/<span[^>]*\sdata-count[^>]*>(\d+)<\/span>/)?.[1] ?? '',
    selected: /\saria-current="page"/.test(openingTag(link)),
    href: link.match(/\shref="([^"]+)"/)?.[1] ?? '',
  }));

test('given a run with messages, tool calls, failed tool calls and a subagent, when its full transcript page is opened, then the rail lists every filter with its count and marks All', async () => {
  const rail = railOf(await pageOf(mixed));

  assert.deepEqual(rail.map(({ label }) => label), FILTER_LABELS);
  assert.deepEqual(rail.map(({ count }) => count), ['8', '3', '3', '2', '1']);
  assert.deepEqual(rail.map(({ selected }) => selected), [true, false, false, false, false]);
});

test('given the same run, when each filter in the rail is followed, then only events of that kind are shown and the selected filter is marked', async () => {
  const app = appWith(mixed);
  const rail = railOf(await (await app.request('/runs/run-01/transcript')).text());
  const shownBy = async (label: string) => {
    const link = rail.find((entry) => entry.label === label);
    const body = await (await app.request(link?.href ?? '')).text();
    return { body, selected: railOf(body).filter(({ selected }) => selected).map((entry) => entry.label) };
  };

  const messages = await shownBy('Messages');
  assert.deepEqual(messages.selected, ['Messages']);
  assert.match(messages.body, /looking/);
  assert.match(messages.body, /done/);
  assert.equal(toolCards(messages.body).length, 0);

  const tools = await shownBy('Tool calls');
  assert.equal(toolCards(tools.body).length, 3);
  assert.doesNotMatch(tools.body, /looking/);

  const errors = await shownBy('Errors');
  assert.deepEqual(errors.selected, ['Errors']);
  assert.deepEqual(toolCards(errors.body).map((card) => /cat missing|make build/.exec(card)?.[0]), ['cat missing', 'make build']);
  assert.doesNotMatch(errors.body, /echo one/);

  const subagents = await shownBy('Subagents');
  assert.match(subagents.body, /data-subagent-call/);
  assert.equal(toolCards(subagents.body).length, 0);
  assert.doesNotMatch(subagents.body, /looking/);
});

test('given a run whose third tool call failed, when the Errors filter is opened, then each event keeps its anchor from the unfiltered page', async () => {
  const events = [call('c1', 'echo one'), answer('c1', 'one'), call('c2', 'echo two'), answer('c2', 'two'), call('c3', 'cat missing'), answer('c3', 'no', true), finished];
  const app = appWith(events);

  const all = await (await app.request('/runs/run-01/transcript')).text();
  const errors = await (await app.request('/runs/run-01/transcript?show=errors')).text();

  const anchorOfFailed = (body: string): string | undefined =>
    body.match(/<div[^>]*\sid="([^"]+)"[^>]*\sdata-event-anchor[^>]*>\s*<details[^>]*\sdata-failed/)?.[1];
  assert.ok(anchorOfFailed(all));
  assert.equal(anchorOfFailed(errors), anchorOfFailed(all));
  assert.deepEqual(idsOf(all).length, 4);
});

test('given a filter the page does not know, when its full transcript page is opened, then it shows all events', async () => {
  const rail = railOf(await pageOf(mixed, '/runs/run-01/transcript?show=bogus'));

  assert.deepEqual(rail.map(({ selected }) => selected), [true, false, false, false, false]);
});

test('given a run with no transcript, when its full transcript page is opened, then it says so', async () => {
  const response = await appWith([], { transcriptRef: null }).request('/runs/run-01/transcript');

  assert.equal(response.status, 200);
  assert.match(textOf(await response.text()), /No transcript captured/);
});

test('given a filtered full transcript page, when it is opened, then the transcript length the live client watches counts only the events shown', async () => {
  const lengthOf = (body: string): string | undefined => body.match(/\sdata-transcript="(\d+)"/)?.[1];

  assert.equal(lengthOf(await pageOf(mixed)), '8');
  assert.equal(lengthOf(await pageOf(mixed, '/runs/run-01/transcript?show=errors')), '2');
  assert.equal(lengthOf(await pageOf(mixed, '/runs/run-01/transcript?show=subagents')), '1');
});

test('given a subagent whose own tool call failed while the subagent itself reported success, when the Errors filter is opened, then the subagent is listed and counted as an error', async () => {
  const events = [
    call('sub', 'delegate'),
    message('child work', { subagent: 'sub' }),
    call('inner', 'cat missing', 'sub'),
    answer('inner', 'no such file', true, 'sub'),
    answer('sub', 'child report'),
    finished,
  ];

  const errors = await pageOf(events, '/runs/run-01/transcript?show=errors');

  assert.deepEqual(railOf(errors).map(({ count }) => count), ['2', '0', '0', '1', '1']);
  assert.match(errors, /data-subagent-call/);
});

test('given a transcript with events but none worth listing, when it is opened, then it does not claim a filter hides them', async () => {
  const body = await pageOf([answer('lost', 'orphaned result')]);

  assert.doesNotMatch(textOf(body), /No events match this filter/);
  assert.match(textOf(body), /No events recorded/);
});
