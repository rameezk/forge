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

const subagentGroups = (body: string): string[] =>
  body.match(/<details class="subagent"[^>]*>[\s\S]*?<\/details>/g) ?? [];

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
    { type: 'message', role: 'assistant', text: 'child reports', usage: { inputTokens: 900, outputTokens: 90 }, costUsd: 0, subagent: 'call-alpha' },
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
