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
  costStatus: 'billed',
  costUsd: 0.1234,
  inputTokens: 4200,
  outputTokens: 850,
  transcriptRef: 'run-01.jsonl',
  sessionId: 'sess-abc',
  error: null,
  ...overrides,
});

const usage = { inputTokens: 5, outputTokens: 5 };

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

const textOf = (fragment: string): string =>
  fragment.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

const rowFor = (body: string, worker: string): string =>
  body.match(new RegExp(`<tr class="run[^"]*">(?:(?!</tr>)[\\s\\S])*>${worker}<[\\s\\S]*?</tr>`))?.[0] ?? '';

test('given a billed run costing $0.00093252, an unconfirmed run, and a pending run, when the list is requested, then each shows its cost status readably and the total adds the billed and unconfirmed runs followed by how many are pending', async () => {
  const app = appWith([
    sampleRun({ id: 'billed', worker: 'billed-worker', costStatus: 'billed', costUsd: 0.00093252 }),
    sampleRun({ id: 'unconfirmed', worker: 'unconfirmed-worker', costStatus: 'unconfirmed', costUsd: 0.0125 }),
    sampleRun({ id: 'pending', worker: 'pending-worker', costStatus: 'pending', costUsd: 0.5 }),
  ]);

  const body = await (await app.request('/')).text();
  const cost = (worker: string): string =>
    textOf(rowFor(body, worker).match(/<td class="cost">[\s\S]*?<\/td>/)?.[0] ?? '');

  assert.equal(cost('billed-worker'), '$0.000933');
  assert.equal(cost('unconfirmed-worker'), '$0.012500 unconfirmed');
  assert.match(rowFor(body, 'unconfirmed-worker'), /<span class="badge" title="[^"]+">unconfirmed<\/span>/);
  assert.equal(cost('pending-worker'), 'pending');
  assert.equal(textOf(body.match(/<tfoot>[\s\S]*?<\/tfoot>/)?.[0] ?? ''), 'Total $0.0134 +1 pending');
});

test('given only settled runs, when the list is requested, then the total carries no pending count', async () => {
  const app = appWith([
    sampleRun({ id: 'billed', costStatus: 'billed', costUsd: 0.2 }),
    sampleRun({ id: 'unconfirmed', costStatus: 'unconfirmed', costUsd: 0.1 }),
  ]);

  const body = await (await app.request('/')).text();

  assert.equal(textOf(body.match(/<tfoot>[\s\S]*?<\/tfoot>/)?.[0] ?? ''), 'Total $0.3000');
});

test('given a pending run and an unconfirmed run, when each transcript page is requested, then the first shows its cost as pending and the second its partial billed sum marked unconfirmed', async () => {
  const app = appWith([
    sampleRun({ id: 'pending', costStatus: 'pending', costUsd: 0.5, transcriptRef: null }),
    sampleRun({ id: 'unconfirmed', costStatus: 'unconfirmed', costUsd: 0.0125, transcriptRef: null }),
  ]);
  const cost = async (id: string): Promise<string> => {
    const body = await (await app.request(`/runs/${id}`)).text();
    return body.match(/<dt>Cost<\/dt>\s*<dd>([\s\S]*?)<\/dd>/)?.[1] ?? '';
  };

  assert.equal(textOf(await cost('pending')), 'pending');
  const unconfirmed = await cost('unconfirmed');
  assert.equal(textOf(unconfirmed), '$0.012500 unconfirmed');
  assert.match(unconfirmed, /<span class="badge" title="[^"]+">unconfirmed<\/span>/);
});

test('given a run that started at 2026-09-28T14:43:24.584Z, when the list and its run page are requested, then both show the start as absolute UTC to the second with the ISO value as a tooltip', async () => {
  const app = appWith([sampleRun({ id: 'run-01', startTime: '2026-09-28T14:43:24.584Z', transcriptRef: null })]);
  const started = '<time datetime="2026-09-28T14:43:24.584Z" title="2026-09-28T14:43:24.584Z">2026-09-28 14:43:24 UTC</time>';

  const list = await (await app.request('/')).text();
  const detail = await (await app.request('/runs/run-01')).text();

  assert.ok(rowFor(list, 'refiner').includes(`<td>${started}</td>`));
  assert.equal(detail.match(/<dt>Started<\/dt>\s*<dd>([\s\S]*?)<\/dd>/)?.[1], started);
});

test('given a run whose recorded start time is not a date, when the list and its run page are requested, then both render and show the recorded value as is', async () => {
  const app = appWith([sampleRun({ id: 'run-01', startTime: 'not-a-date', transcriptRef: null })]);

  const list = await app.request('/');
  const detail = await app.request('/runs/run-01');

  assert.equal(list.status, 200);
  assert.equal(detail.status, 200);
  assert.match(await list.text(), /<time datetime="not-a-date" title="not-a-date">not-a-date<\/time>/);
  assert.match(await detail.text(), /<time datetime="not-a-date" title="not-a-date">not-a-date<\/time>/);
});

test('given a run with 44991 input and 3480 output tokens, when its run page is requested, then the counts carry thousands separators', async () => {
  const app = appWith([sampleRun({ id: 'run-01', inputTokens: 44991, outputTokens: 3480, transcriptRef: null })]);

  const body = await (await app.request('/runs/run-01')).text();

  assert.equal(textOf(body.match(/<dt>Tokens<\/dt>\s*<dd>([\s\S]*?)<\/dd>/)?.[1] ?? ''), '44,991 in / 3,480 out');
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

test('given a successful run and a failed run, when each run page is requested, then each transcript ends with a status badge styled like the run list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-transcripts-'));
  const transcript = (status: 'success' | 'error', error: string | null): string =>
    [
      { type: 'message', role: 'assistant', text: 'done', usage, costUsd: 0 },
      { type: 'result', status, sessionId: 'sess-abc', error },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(join(dir, 'ok.jsonl'), transcript('success', null));
  writeFileSync(join(dir, 'failed.jsonl'), transcript('error', 'provider exploded'));
  const app = appWith([
    sampleRun({ id: 'ok', worker: 'ok-worker', status: 'success', transcriptRef: 'ok.jsonl' }),
    sampleRun({ id: 'failed', worker: 'failed-worker', status: 'error', error: 'provider exploded', transcriptRef: 'failed.jsonl' }),
  ], dir);
  const list = await (await app.request('/')).text();
  const listBadge = (worker: string): string =>
    rowFor(list, worker).match(/<span class="status [^"]*">[^<]*<\/span>/)?.[0] ?? 'missing';
  const closing = async (id: string): Promise<string> => {
    const body = await (await app.request(`/runs/${id}`)).text();
    return body.match(/<article class="message message-result">([\s\S]*?)<\/article>\s*<\/main>/)?.[1] ?? '';
  };

  const ok = await closing('ok');
  const failed = await closing('failed');

  assert.ok(ok.includes(listBadge('ok-worker')), ok);
  assert.equal(textOf(ok), 'success');
  assert.ok(failed.includes(listBadge('failed-worker')), failed);
  assert.equal(textOf(failed), 'error provider exploded');
});

test('given no such run, when its detail is requested, then the response is 404', async () => {
  const app = appWith([]);

  const res = await app.request('/runs/missing');
  assert.equal(res.status, 404);
});

const detailsBlocks = (body: string, opening: RegExp): string[] => {
  const blocks: string[] = [];
  for (const match of body.matchAll(opening)) {
    let depth = 0;
    for (const tag of body.slice(match.index).matchAll(/<details\b|<\/details>/g)) {
      depth += tag[0] === '</details>' ? -1 : 1;
      if (depth === 0) {
        blocks.push(body.slice(match.index, match.index + tag.index + tag[0].length));
        break;
      }
    }
  }
  return blocks;
};

const subagentGroups = (body: string): string[] => detailsBlocks(body, /<details class="subagent"/g);
const subagentCalls = (body: string): string[] => body.match(/<section class="tool subagent-call[\s\S]*?<\/section>/g) ?? [];

test('given a transcript written before subagent calls were recorded, when its transcript is viewed, then each subagent scope still renders grouped and collapsed under its scope and the parent renders ungrouped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-transcripts-'));
  const events: HarnessEvent[] = [
    { type: 'message', role: 'assistant', text: 'parent delegates two reviews', usage, costUsd: 0 },
    { type: 'message', role: 'assistant', text: 'alpha reading the diff', usage, costUsd: 0, subagent: 'call-alpha' },
    { type: 'message', role: 'assistant', text: 'beta scanning for secrets', usage, costUsd: 0, subagent: 'call-beta' },
    { type: 'message', role: 'assistant', text: 'alpha report: two findings', usage, costUsd: 0, subagent: 'call-alpha' },
    { type: 'message', role: 'assistant', text: 'beta report: clean', usage, costUsd: 0, subagent: 'call-beta' },
    { type: 'message', role: 'assistant', text: 'parent triages the findings', usage, costUsd: 0 },
    { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
  ];
  writeFileSync(join(dir, 'run-01.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const app = appWith([sampleRun({ id: 'run-01', transcriptRef: 'run-01.jsonl' })], dir);

  const body = await (await app.request('/runs/run-01')).text();
  const groups = subagentGroups(body);

  assert.equal(groups.length, 2, 'each subagent scope renders as one group');
  const [alpha, beta] = groups as [string, string];
  assert.match(alpha, /alpha reading the diff[\s\S]*alpha report: two findings/);
  assert.doesNotMatch(alpha, /beta|parent/);
  assert.match(beta, /beta scanning for secrets[\s\S]*beta report: clean/);
  assert.doesNotMatch(beta, /alpha|parent/);
  for (const group of groups) {
    assert.doesNotMatch(group.slice(0, group.indexOf('>')), /\bopen\b/, 'groups are collapsed by default');
  }
  assert.match(alpha, /<summary>[\s\S]*call-alpha[\s\S]*2 messages[\s\S]*<\/summary>/, 'a collapsed group names its subagent and how much it did');
  assert.doesNotMatch(body, /class="message message-report"/, 'without a recorded subagent result there is no report card');
  assert.equal(subagentCalls(body).length, 0);
  assert.ok(
    body.indexOf('parent delegates two reviews') < body.indexOf(alpha) &&
      body.indexOf(beta) < body.indexOf('parent triages the findings'),
    'parent messages render ungrouped, in order around the groups',
  );
});

test('given a run whose recorded tokens and cost include its subagents, when it is listed and viewed, then the displayed totals are the recorded ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-transcripts-'));
  const events: HarnessEvent[] = [
    { type: 'message', role: 'assistant', text: 'parent delegates', usage: { inputTokens: 100, outputTokens: 10 }, costUsd: 0 },
    { type: 'message', role: 'assistant', text: 'child reports', usage: { inputTokens: 700, outputTokens: 40 }, costUsd: 0, subagent: 'call-alpha' },
    { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
  ];
  writeFileSync(join(dir, 'run-01.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const app = appWith(
    [sampleRun({ id: 'run-01', transcriptRef: 'run-01.jsonl', costUsd: 0.75, inputTokens: 1000, outputTokens: 100 })],
    dir,
  );

  const list = await (await app.request('/')).text();
  const detail = await (await app.request('/runs/run-01')).text();

  assert.match(list, /<td class="cost">\s*\$0\.750000/);
  assert.match(detail, /\$0\.750000/);
  assert.match(detail, /1,000 in \/ 100 out/);
});

const toolCards = (body: string): string[] => detailsBlocks(body, /<details class="tool[ "]/g);

const viewTranscript = async (events: HarnessEvent[]): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-transcripts-'));
  writeFileSync(join(dir, 'run-01.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const app = appWith([sampleRun({ id: 'run-01', transcriptRef: 'run-01.jsonl' })], dir);
  return (await app.request('/runs/run-01')).text();
};

test('given a run whose agent made a bash call in a turn with no text, when its run page is viewed, then a collapsed card shows the tool name and command and no empty assistant card renders', async () => {
  const body = await viewTranscript([
    { type: 'message', role: 'user', text: 'run echo forge', usage, costUsd: 0 },
    { type: 'message', role: 'assistant', text: '', usage, costUsd: 0 },
    { type: 'tool_call', id: 'call_1', name: 'bash', arguments: { command: 'echo forge' } },
    { type: 'tool_result', id: 'call_1', isError: false, text: 'forge\n' },
    { type: 'message', role: 'assistant', text: 'it printed forge', usage, costUsd: 0 },
    { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
  ]);

  const cards = toolCards(body);
  assert.equal(cards.length, 1);
  const [card] = cards as [string];
  assert.match(card, /<summary>[\s\S]*bash[\s\S]*echo forge[\s\S]*<\/summary>/);
  assert.doesNotMatch(card.slice(0, card.indexOf('>')), /\bopen\b/, 'a successful call is collapsed by default');
  assert.doesNotMatch(body, /<header>assistant<\/header>\s*<pre><\/pre>/);
  assert.ok(
    body.indexOf('run echo forge') < body.indexOf(card) && body.indexOf(card) < body.indexOf('it printed forge'),
    'the card renders in transcript order',
  );
});

test('given parallel tool calls whose results arrive out of order, when a card is expanded, then it shows its own arguments as pretty json and its own result', async () => {
  const body = await viewTranscript([
    { type: 'message', role: 'assistant', text: 'checking both', usage, costUsd: 0 },
    { type: 'tool_call', id: 'call_1', name: 'read', arguments: { path: 'a.txt', limit: 10 } },
    { type: 'tool_call', id: 'call_2', name: 'read', arguments: { path: 'b.txt' } },
    { type: 'tool_result', id: 'call_2', isError: false, text: 'contents of b' },
    { type: 'tool_result', id: 'call_1', isError: false, text: 'contents of a' },
    { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
  ]);

  const [first, second] = toolCards(body) as [string, string];
  assert.match(first, /<summary>[\s\S]*read[\s\S]*a\.txt[\s\S]*<\/summary>/);
  assert.ok(first.includes(JSON.stringify({ path: 'a.txt', limit: 10 }, null, 2).replaceAll('"', '&quot;')));
  assert.match(first, /contents of a/);
  assert.doesNotMatch(first, /contents of b/);
  assert.match(second, /b\.txt[\s\S]*contents of b/);
  assert.doesNotMatch(second, /contents of a/);
});

test('given a run with a tool call that returned an error beside one that succeeded, when its run page is viewed, then only the failed card is highlighted and open by default', async () => {
  const body = await viewTranscript([
    { type: 'tool_call', id: 'call_1', name: 'bash', arguments: { command: 'echo forge' } },
    { type: 'tool_result', id: 'call_1', isError: false, text: 'forge\n' },
    { type: 'tool_call', id: 'call_2', name: 'bash', arguments: { command: 'cat missing.txt' } },
    { type: 'tool_result', id: 'call_2', isError: true, text: 'cat: missing.txt: No such file or directory' },
    { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
  ]);

  const [ok, failed] = toolCards(body) as [string, string];
  const openingTag = (card: string): string => card.slice(0, card.indexOf('>'));
  assert.equal(openingTag(ok), '<details class="tool"');
  assert.match(openingTag(failed), /class="tool tool-error"/);
  assert.match(openingTag(failed), /\bopen\b/);
  assert.match(failed, /No such file or directory/);
});

test('given a subagent tool call sharing its id with a parent tool call, when the run page is viewed, then the subagent card renders inside its group with its own result and the parent card keeps its own', async () => {
  const body = await viewTranscript([
    { type: 'tool_call', id: 'call_1', name: 'bash', arguments: { command: 'echo parent' } },
    { type: 'tool_result', id: 'call_1', isError: false, text: 'parent output' },
    { type: 'message', role: 'assistant', text: '', usage, costUsd: 0, subagent: 'call-alpha' },
    { type: 'tool_call', id: 'call_1', name: 'bash', arguments: { command: 'echo alpha' }, subagent: 'call-alpha' },
    { type: 'tool_result', id: 'call_1', isError: false, text: 'alpha output', subagent: 'call-alpha' },
    { type: 'message', role: 'assistant', text: 'alpha report', usage, costUsd: 0, subagent: 'call-alpha' },
    { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
  ]);

  const [group] = subagentGroups(body) as [string];
  assert.match(group, /<summary>[\s\S]*1 message[\s\S]*<\/summary>/);
  const [inner] = toolCards(group) as [string];
  assert.match(inner, /echo alpha[\s\S]*alpha output/);
  assert.doesNotMatch(inner, /parent/);
  assert.doesNotMatch(group, /<header>assistant<\/header>\s*<pre><\/pre>/);
  const [outer] = toolCards(body) as [string];
  assert.match(outer, /echo parent[\s\S]*parent output/);
  assert.doesNotMatch(outer, /alpha/);
});

test('given a tool call whose arguments were capped and which never got a result, when the run page is viewed, then its card shows the capped text and says no result was recorded', async () => {
  const capped = '{"command":"echo ffff\n...cut';
  const body = await viewTranscript([
    { type: 'tool_call', id: 'call_1', name: 'bash', arguments: capped },
    { type: 'result', status: 'error', sessionId: 'sess-abc', error: 'pi exited on signal SIGKILL' },
  ]);

  const [card] = toolCards(body) as [string];
  assert.match(card, /<summary>[\s\S]*bash[\s\S]*<code[^>]*>\{&quot;command&quot;:&quot;echo ffff \.\.\.cut<\/code>/);
  assert.match(card, /<pre>\{&quot;command&quot;:&quot;echo ffff\n\.\.\.cut<\/pre>/);
  assert.match(card, /No result recorded\./);
});

test('given a transcript written before tool events were recorded, when its run page is viewed, then every message renders as before, including an empty assistant turn, and no tool card appears', async () => {
  const body = await viewTranscript([
    { type: 'message', role: 'user', text: 'run echo forge', usage, costUsd: 0 },
    { type: 'message', role: 'assistant', text: '', usage, costUsd: 0 },
    { type: 'message', role: 'assistant', text: 'it printed forge', usage, costUsd: 0 },
    { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
  ]);

  assert.equal(toolCards(body).length, 0);
  assert.equal(body.match(/<article class="message message-assistant">/g)?.length, 2);
  assert.match(body, /<header>assistant<\/header>\s*<pre><\/pre>/);
  assert.match(body, /<article class="message message-result"><span class="status status-success">success<\/span><\/article>/);
});

test('given a provider that reuses a tool call id across turns, when the run page is viewed, then each card shows the result that followed it', async () => {
  const body = await viewTranscript([
    { type: 'tool_call', id: 'call_0', name: 'bash', arguments: { command: 'echo first' } },
    { type: 'tool_result', id: 'call_0', isError: true, text: 'first output' },
    { type: 'tool_call', id: 'call_0', name: 'bash', arguments: { command: 'echo second' } },
    { type: 'tool_result', id: 'call_0', isError: false, text: 'second output' },
    { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
  ]);

  const [first, second] = toolCards(body) as [string, string];
  assert.match(first, /echo first[\s\S]*first output/);
  assert.match(first, /class="tool tool-error"/);
  assert.doesNotMatch(first, /second output/);
  assert.match(second, /echo second[\s\S]*second output/);
  assert.doesNotMatch(second, /first output|tool-error/);
});

const delegation: HarnessEvent[] = [
  { type: 'message', role: 'assistant', text: 'Delegating both.', usage, costUsd: 0 },
  { type: 'tool_call', id: 'call_alpha', name: 'subagent', arguments: { task: 'Run echo alpha and report what it printed.' } },
  { type: 'tool_call', id: 'call_beta', name: 'subagent', arguments: { task: 'Say beta.' } },
  { type: 'message', role: 'assistant', text: 'Running it.', usage, costUsd: 0, subagent: 'call_alpha' },
  { type: 'tool_call', id: 'call_1', name: 'bash', arguments: { command: 'echo alpha' }, subagent: 'call_alpha' },
  { type: 'tool_result', id: 'call_1', isError: false, text: 'alpha\n', subagent: 'call_alpha' },
  { type: 'message', role: 'assistant', text: 'Alpha report: echo alpha printed alpha.', usage, costUsd: 0, subagent: 'call_alpha' },
  { type: 'message', role: 'assistant', text: 'Beta report: beta.', usage, costUsd: 0, subagent: 'call_beta' },
  { type: 'tool_result', id: 'call_beta', isError: false, text: 'Beta report: beta.' },
  { type: 'tool_result', id: 'call_alpha', isError: false, text: 'Alpha report: echo alpha printed alpha.' },
  { type: 'message', role: 'assistant', text: 'Both sub-agents reported back.', usage, costUsd: 0 },
  { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
];

test('given a run whose agent spawned two subagents from one message, when its run page is viewed, then both groups appear nested under that turn in always-expanded subagent call cards', async () => {
  const body = await viewTranscript(delegation);

  const calls = subagentCalls(body);
  assert.equal(calls.length, 2, 'each subagent call renders as one card');
  const [alpha, beta] = calls as [string, string];
  assert.equal(subagentGroups(alpha).length, 1);
  assert.equal(subagentGroups(beta).length, 1);
  assert.equal(subagentGroups(body).length, 2, 'no group renders outside its call card');
  assert.match(alpha, /Running it\.[\s\S]*echo alpha/);
  assert.doesNotMatch(alpha, /beta/i);
  assert.doesNotMatch(beta, /alpha/i);
  assert.doesNotMatch(alpha.slice(0, alpha.indexOf('<details')), /<details|<summary/, 'a subagent call card cannot be collapsed');
  assert.ok(
    body.indexOf('Delegating both.') < body.indexOf(alpha) &&
      body.indexOf(alpha) < body.indexOf(beta) &&
      body.indexOf(beta) < body.indexOf('Both sub-agents reported back.'),
    'both cards render between the delegating turn and the parent reply',
  );
  assert.equal(toolCards(body).filter((card) => /subagent/.test(card.slice(0, card.indexOf('</summary>')))).length, 0, 'subagent calls do not also render as plain tool cards');
});

test('given a run whose agent spawned two subagents, when its run page is viewed, then each group is titled by its task and not by its tool call id', async () => {
  const body = await viewTranscript(delegation);

  const [alpha, beta] = subagentCalls(body) as [string, string];
  const summaryOf = (card: string): string => card.slice(card.indexOf('<summary>'), card.indexOf('</summary>'));
  assert.match(summaryOf(alpha), /<span class="subagent-task" title="Run echo alpha and report what it printed\.">Run echo alpha and report what it printed\.<\/span>/);
  assert.match(summaryOf(beta), /<span class="subagent-task" title="Say beta\.">Say beta\.<\/span>/);
  assert.match(summaryOf(alpha), /2 messages/);
  assert.match(summaryOf(beta), /1 message\b/);
  assert.doesNotMatch(body, /call_alpha|call_beta/);
});

test('given a subagent given a long multi-line task, when its group is expanded, then the whole task is shown and the header keeps it on one line', async () => {
  const task = 'Review the diff.\n\nReport each finding with its file and line.';
  const body = await viewTranscript([
    { type: 'tool_call', id: 'call_alpha', name: 'subagent', arguments: { task } },
    { type: 'message', role: 'assistant', text: 'reviewing', usage, costUsd: 0, subagent: 'call_alpha' },
    { type: 'tool_result', id: 'call_alpha', isError: false, text: 'clean' },
    { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
  ]);

  const [card] = subagentCalls(body) as [string];
  assert.match(card, /<span class="subagent-task" title="Review the diff\. Report each finding with its file and line\.">/);
  assert.match(card, /<header>task<\/header>\s*<pre>Review the diff\.\n\nReport each finding with its file and line\.<\/pre>/);
});

test('given a run whose agent spawned two subagents, when a group is viewed, then its report is the subagent tool result, shown once', async () => {
  const body = await viewTranscript(delegation);

  const [alpha, beta] = subagentCalls(body) as [string, string];
  assert.equal(alpha.match(/Alpha report: echo alpha printed alpha\./g)?.length, 1);
  assert.equal(beta.match(/Beta report: beta\./g)?.length, 1);
  assert.match(alpha, /<article class="message message-report">\s*<header>report<\/header>\s*<pre>Alpha report: echo alpha printed alpha\.<\/pre>\s*<\/article>\s*<\/div>\s*<\/details>/, 'the report closes the group');
  assert.match(alpha, /<header>assistant<\/header>\s*<pre>Running it\.<\/pre>/, 'earlier child messages still render');
  assert.equal(body.match(/class="message message-report"/g)?.length, 2);
});

test("given a subagent whose final message differs from the result the parent received, when its group is viewed, then both render and the report is the parent's result", async () => {
  const body = await viewTranscript([
    { type: 'tool_call', id: 'call_alpha', name: 'subagent', arguments: { task: 'Summarise the log.' } },
    { type: 'message', role: 'assistant', text: 'full summary', usage, costUsd: 0, subagent: 'call_alpha' },
    { type: 'tool_result', id: 'call_alpha', isError: false, text: 'full sum\n...cut' },
    { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
  ]);

  const [card] = subagentCalls(body) as [string];
  assert.match(card, /<header>assistant<\/header>\s*<pre>full summary<\/pre>/);
  assert.match(card, /<header>report<\/header>\s*<pre>full sum\n\.\.\.cut<\/pre>/);
});

test('given a subagent call that returned an error, when its run page is viewed, then its card is highlighted, its group is open and the error is its report', async () => {
  const body = await viewTranscript([
    { type: 'tool_call', id: 'call_alpha', name: 'subagent', arguments: { task: 'Say alpha.' } },
    { type: 'tool_call', id: 'call_beta', name: 'subagent', arguments: { task: 'Say beta.' } },
    { type: 'message', role: 'assistant', text: 'partial', usage, costUsd: 0, subagent: 'call_alpha' },
    { type: 'message', role: 'assistant', text: 'beta', usage, costUsd: 0, subagent: 'call_beta' },
    { type: 'tool_result', id: 'call_alpha', isError: true, text: 'Sub-agent failed: provider error' },
    { type: 'tool_result', id: 'call_beta', isError: false, text: 'beta' },
    { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
  ]);

  const [failed, ok] = subagentCalls(body) as [string, string];
  assert.match(failed, /^<section class="tool subagent-call tool-error">/);
  assert.match(failed, /<span class="badge tool-status">error<\/span>/);
  assert.match(failed, /<details class="subagent" open>/);
  assert.match(failed, /<header>assistant<\/header>\s*<pre>partial<\/pre>/);
  assert.match(failed, /<article class="message message-error">\s*<header>error<\/header>\s*<pre>Sub-agent failed: provider error<\/pre>/);
  assert.match(ok, /^<section class="tool subagent-call">/);
  assert.match(ok, /<details class="subagent">/);
  assert.doesNotMatch(ok, /tool-status/);
});

test('given a subagent call that never got a result, when its run page is viewed, then its group says no report was recorded', async () => {
  const body = await viewTranscript([
    { type: 'tool_call', id: 'call_alpha', name: 'subagent', arguments: { task: 'Say alpha.' } },
    { type: 'message', role: 'assistant', text: 'working on it', usage, costUsd: 0, subagent: 'call_alpha' },
    { type: 'result', status: 'error', sessionId: 'sess-abc', error: 'pi exited on signal SIGKILL' },
  ]);

  const [card] = subagentCalls(body) as [string];
  assert.match(card, /working on it[\s\S]*<p class="empty">No report recorded\.<\/p>/);
  assert.doesNotMatch(card, /class="message message-report"/);
});

test('given a provider that reuses a subagent call id across turns, when the run page is viewed, then each child nests under the call that spawned it', async () => {
  const body = await viewTranscript([
    { type: 'tool_call', id: 'call_0', name: 'subagent', arguments: { task: 'First task.' } },
    { type: 'message', role: 'assistant', text: 'first child working', usage, costUsd: 0, subagent: 'call_0' },
    { type: 'tool_result', id: 'call_0', isError: false, text: 'first report' },
    { type: 'tool_call', id: 'call_0', name: 'subagent', arguments: { task: 'Second task.' } },
    { type: 'message', role: 'assistant', text: 'second child working', usage, costUsd: 0, subagent: 'call_0' },
    { type: 'tool_result', id: 'call_0', isError: false, text: 'second report' },
    { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
  ]);

  const [first, second] = subagentCalls(body) as [string, string];
  assert.match(first, /First task\.[\s\S]*first child working[\s\S]*first report/);
  assert.doesNotMatch(first, /second/);
  assert.match(second, /Second task\.[\s\S]*second child working[\s\S]*second report/);
  assert.doesNotMatch(second, /first/);
});

test('given a subagent given an explicit working directory, when its group is expanded, then the working directory is shown with the task', async () => {
  const body = await viewTranscript([
    { type: 'tool_call', id: 'call_alpha', name: 'subagent', arguments: { task: 'List the files.', cwd: 'repo/src' } },
    { type: 'message', role: 'assistant', text: 'two files', usage, costUsd: 0, subagent: 'call_alpha' },
    { type: 'tool_result', id: 'call_alpha', isError: false, text: 'two files' },
    { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
  ]);

  const [card] = subagentCalls(body) as [string];
  assert.match(card, /<header>cwd<\/header>\s*<pre>repo\/src<\/pre>[\s\S]*<header>task<\/header>\s*<pre>List the files\.<\/pre>/);
});

test('given a subagent call whose arguments carry no task text, when its run page is viewed, then its header and body show the same arguments', async () => {
  const capped = '{"task":"Review the diff\n...cut';
  const body = await viewTranscript([
    { type: 'tool_call', id: 'call_alpha', name: 'subagent', arguments: { cwd: 'repo' } },
    { type: 'tool_call', id: 'call_beta', name: 'subagent', arguments: capped },
    { type: 'message', role: 'assistant', text: 'working', usage, costUsd: 0, subagent: 'call_alpha' },
    { type: 'message', role: 'assistant', text: 'working', usage, costUsd: 0, subagent: 'call_beta' },
    { type: 'result', status: 'error', sessionId: 'sess-abc', error: 'pi exited on signal SIGKILL' },
  ]);

  const [alpha, beta] = subagentCalls(body) as [string, string];
  assert.match(alpha, /<span class="subagent-task" title="\{ &quot;cwd&quot;: &quot;repo&quot; \}">/);
  assert.match(alpha, /<header>task<\/header>\s*<pre>\{\n  &quot;cwd&quot;: &quot;repo&quot;\n\}<\/pre>/);
  assert.match(beta, /<span class="subagent-task" title="\{&quot;task&quot;:&quot;Review the diff \.\.\.cut">/);
  assert.match(beta, /<header>task<\/header>\s*<pre>\{&quot;task&quot;:&quot;Review the diff\n\.\.\.cut<\/pre>/);
});

test('given a harness whose spawning tool has another name, when its run page is viewed, then children still nest under the call their scope names', async () => {
  const body = await viewTranscript([
    { type: 'tool_call', id: 'toolu_01', name: 'Task', arguments: { task: 'Count the files.' } },
    { type: 'message', role: 'assistant', text: 'three files', usage, costUsd: 0, subagent: 'toolu_01' },
    { type: 'tool_result', id: 'toolu_01', isError: false, text: 'three files' },
    { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
  ]);

  const [card] = subagentCalls(body) as [string];
  assert.match(card, /<span class="tool-name">Task<\/span>[\s\S]*Count the files\.[\s\S]*<header>report<\/header>\s*<pre>three files<\/pre>/);
  assert.equal(toolCards(body).length, 0);
});

test('given a subagent call that failed before its child produced any activity, when its run page is viewed, then it renders as an ordinary tool card that is highlighted and open', async () => {
  const body = await viewTranscript([
    { type: 'tool_call', id: 'call_alpha', name: 'subagent', arguments: { task: 'List the files.', cwd: '../outside' } },
    { type: 'tool_result', id: 'call_alpha', isError: true, text: 'working directory escapes the run directory' },
    { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
  ]);

  assert.equal(subagentCalls(body).length, 0);
  const [card] = toolCards(body) as [string];
  assert.match(card, /^<details class="tool tool-error" open>/);
  assert.match(card, /List the files\.[\s\S]*\.\.\/outside[\s\S]*working directory escapes the run directory/);
});
