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
  assert.match(body, /title="OpenRouter's billed cost could not be confirmed for every generation"/, 'the badge must explain what uncertain means');
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

test('given a run whose transcript holds events from two subagent scopes, when its transcript is viewed, then each subagent renders grouped and collapsed and the parent renders ungrouped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-transcripts-'));
  const usage = { inputTokens: 5, outputTokens: 5 };
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
  assert.match(alpha, /<article class="message message-report">\s*<header>report<\/header>\s*<pre>alpha report: two findings<\/pre>/, "the child's final message is its report");
  assert.match(beta, /<article class="message message-report">\s*<header>report<\/header>\s*<pre>beta report: clean<\/pre>/, "the child's final message is its report");
  assert.doesNotMatch(alpha.replace(/<article class="message message-report">[\s\S]*?<\/article>/, ''), /report/, 'only the final message is the report');
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

  assert.match(list, /<td class="cost">\s*\$0\.7500/);
  assert.match(detail, /\$0\.7500/);
  assert.match(detail, /1000 in \/ 100 out/);
});

const toolCards = (body: string): string[] => detailsBlocks(body, /<details class="tool[ "]/g);

const viewTranscript = async (events: HarnessEvent[]): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-transcripts-'));
  writeFileSync(join(dir, 'run-01.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const app = appWith([sampleRun({ id: 'run-01', transcriptRef: 'run-01.jsonl' })], dir);
  return (await app.request('/runs/run-01')).text();
};

test('given a run whose agent made a bash call in a turn with no text, when its run page is viewed, then a collapsed card shows the tool name and command and no empty assistant card renders', async () => {
  const usage = { inputTokens: 5, outputTokens: 5 };
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
  const usage = { inputTokens: 5, outputTokens: 5 };
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
  const usage = { inputTokens: 5, outputTokens: 5 };
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
  const capped = '{"command":"echo ffff\n[truncated 7232 characters]';
  const body = await viewTranscript([
    { type: 'tool_call', id: 'call_1', name: 'bash', arguments: capped },
    { type: 'result', status: 'error', sessionId: 'sess-abc', error: 'pi exited on signal SIGKILL' },
  ]);

  const [card] = toolCards(body) as [string];
  assert.match(card, /<summary>[\s\S]*bash[\s\S]*<code[^>]*>\{&quot;command&quot;:&quot;echo ffff \[truncated 7232 characters\]<\/code>/);
  assert.match(card, /<pre>\{&quot;command&quot;:&quot;echo ffff\n\[truncated 7232 characters\]<\/pre>/);
  assert.match(card, /No result recorded\./);
});

test('given a transcript written before tool events were recorded, when its run page is viewed, then every message renders as before, including an empty assistant turn, and no tool card appears', async () => {
  const usage = { inputTokens: 5, outputTokens: 5 };
  const body = await viewTranscript([
    { type: 'message', role: 'user', text: 'run echo forge', usage, costUsd: 0 },
    { type: 'message', role: 'assistant', text: '', usage, costUsd: 0 },
    { type: 'message', role: 'assistant', text: 'it printed forge', usage, costUsd: 0 },
    { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
  ]);

  assert.equal(toolCards(body).length, 0);
  assert.equal(body.match(/<article class="message message-assistant">/g)?.length, 2);
  assert.match(body, /<header>assistant<\/header>\s*<pre><\/pre>/);
  assert.match(body, /Run success/);
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
