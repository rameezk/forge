import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import type { HarnessEvent, LookupResult, RunRecord } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { openingTag, textOf } from './html.ts';

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
  ticket: null,
  ...overrides,
});

const usage = { inputTokens: 5, outputTokens: 5 };

const appWith = (runs: RunRecord[], dir: string = mkdtempSync(join(tmpdir(), 'forge-transcripts-'))) => {
  const store = Store.open(':memory:');
  for (const run of runs) store.insertRun(run);
  return createApp({ store, transcripts: new FileTranscriptSource(dir), css: '', logo: '' });
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

const rowFor = (body: string, id: string): string =>
  body.match(new RegExp(`<tr[^>]*\\sdata-run="${id}"[\\s\\S]*?</tr>`))?.[0] ?? '';

const statusIn = (fragment: string): string =>
  fragment.match(/<span[^>]*\sdata-status="[^"]*"[^>]*>[^<]*<\/span>/)?.[0] ?? 'missing';

test('given a billed run costing $0.00093252, an unconfirmed run, and a pending run, when the list is requested, then each shows its cost status readably and the total adds the billed and unconfirmed runs followed by how many are pending', async () => {
  const app = appWith([
    sampleRun({ id: 'billed', worker: 'billed-worker', costStatus: 'billed', costUsd: 0.00093252 }),
    sampleRun({ id: 'unconfirmed', worker: 'unconfirmed-worker', costStatus: 'unconfirmed', costUsd: 0.0125 }),
    sampleRun({ id: 'pending', worker: 'pending-worker', costStatus: 'pending', costUsd: 0.5 }),
  ]);

  const body = await (await app.request('/')).text();
  const cost = (id: string): string =>
    textOf(rowFor(body, id).match(/<td[^>]*\sdata-cost(?=[\s>])[^>]*>[\s\S]*?<\/td>/)?.[0] ?? '');

  assert.equal(cost('billed'), '$0.000933');
  assert.equal(cost('unconfirmed'), '$0.012500 unconfirmed');
  assert.match(rowFor(body, 'unconfirmed'), /<span[^>]*\sdata-badge="unconfirmed"[^>]*\stitle="[^"]+"[^>]*>unconfirmed<\/span>/);
  assert.equal(cost('pending'), 'pending');
  assert.equal(textOf(body.match(/<tfoot>[\s\S]*?<\/tfoot>/)?.[0] ?? ''), 'Total $0.0134 +1 pending');
});

test('given a successful, a failed and a running run, when the list is requested, then each row shows its own status', async () => {
  const app = appWith([
    sampleRun({ id: 'ok', status: 'success' }),
    sampleRun({ id: 'failed', status: 'error', error: 'provider exploded' }),
    sampleRun({ id: 'running', status: 'running', endTime: null, costStatus: 'pending' }),
  ]);

  const body = await (await app.request('/')).text();
  for (const [id, status] of [['ok', 'success'], ['failed', 'error'], ['running', 'running']] as const) {
    const badge = statusIn(rowFor(body, id));
    assert.match(badge, new RegExp(`\\sdata-status="${status}"`));
    assert.equal(textOf(badge), status);
  }
});

test('given a run dispatched for a ticket and a run started by hand, when the list is requested, then the dispatched run shows its repository and ticket linked to the issue and the other shows none', async () => {
  const app = appWith([
    sampleRun({
      id: 'dispatched',
      ticket: { repository: 'forge', number: 113, url: 'https://github.com/rameezk/forge/issues/113' },
    }),
    sampleRun({ id: 'by-hand' }),
  ]);

  const body = await (await app.request('/')).text();
  const ticketCell = (id: string): string =>
    rowFor(body, id).match(/<td[^>]*\sdata-run-ticket(?=[\s>])[^>]*>[\s\S]*?<\/td>/)?.[0] ?? 'missing';

  assert.equal(textOf(ticketCell('dispatched')), 'forge #113');
  assert.match(ticketCell('dispatched'), /<a href="https:\/\/github\.com\/rameezk\/forge\/issues\/113"[^>]*>#113<\/a>/);
  assert.equal(textOf(ticketCell('by-hand')), '');
  assert.match(body, /<th[^>]*>Ticket<\/th>/);
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
    return body.match(/<dt[^>]*>Cost<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/)?.[1] ?? '';
  };

  assert.equal(textOf(await cost('pending')), 'pending');
  const unconfirmed = await cost('unconfirmed');
  assert.equal(textOf(unconfirmed), '$0.012500 unconfirmed');
  assert.match(unconfirmed, /<span[^>]*\sdata-badge="unconfirmed"[^>]*\stitle="[^"]+"[^>]*>unconfirmed<\/span>/);
});

test('given a run that started at 2026-09-28T14:43:24.584Z, when the list and its run page are requested, then both show the start as absolute UTC to the second with the ISO value as a tooltip', async () => {
  const app = appWith([sampleRun({ id: 'run-01', startTime: '2026-09-28T14:43:24.584Z', transcriptRef: null })]);
  const started = /^<time datetime="2026-09-28T14:43:24\.584Z" title="2026-09-28T14:43:24\.584Z"[^>]*>2026-09-28 14:43:24 UTC<\/time>$/;

  const list = await (await app.request('/')).text();
  const detail = await (await app.request('/runs/run-01')).text();

  assert.match(rowFor(list, 'run-01').match(/<td[^>]*>(<time[\s\S]*?<\/time>)<\/td>/)?.[1] ?? '', started);
  assert.match(detail.match(/<dt[^>]*>Started<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/)?.[1] ?? '', started);
});

test('given a run whose recorded start time is not a date, when the list and its run page are requested, then both render and show the recorded value as is', async () => {
  const app = appWith([sampleRun({ id: 'run-01', startTime: 'not-a-date', transcriptRef: null })]);

  const list = await app.request('/');
  const detail = await app.request('/runs/run-01');

  assert.equal(list.status, 200);
  assert.equal(detail.status, 200);
  assert.match(await list.text(), /<time datetime="not-a-date" title="not-a-date"[^>]*>not-a-date<\/time>/);
  assert.match(await detail.text(), /<time datetime="not-a-date" title="not-a-date"[^>]*>not-a-date<\/time>/);
});

test('given a run with 44991 input and 3480 output tokens, when its run page is requested, then the counts carry thousands separators', async () => {
  const app = appWith([sampleRun({ id: 'run-01', inputTokens: 44991, outputTokens: 3480, transcriptRef: null })]);

  const body = await (await app.request('/runs/run-01')).text();

  assert.equal(textOf(body.match(/<dt[^>]*>Tokens<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/)?.[1] ?? ''), '44,991 in / 3,480 out');
});

test('given a run with a captured transcript, when its detail is requested, then its messages render', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-transcripts-'));
  const events: HarnessEvent[] = [
    { type: 'message', role: 'user', text: 'refine the spec please', usage: { inputTokens: 10, outputTokens: 0 }, generationId: null },
    { type: 'message', role: 'assistant', text: 'here is the refined spec', usage: { inputTokens: 0, outputTokens: 20 }, generationId: null },
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

test('given a successful run and a failed run, when each run page is requested, then its header status and the closing transcript line are status badges styled like the run list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-transcripts-'));
  const transcript = (status: 'success' | 'error', error: string | null): string =>
    [
      { type: 'message', role: 'assistant', text: 'done', usage, generationId: null },
      { type: 'result', status, sessionId: 'sess-abc', error },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(join(dir, 'ok.jsonl'), transcript('success', null));
  writeFileSync(join(dir, 'failed.jsonl'), transcript('error', 'provider exploded'));
  const app = appWith([
    sampleRun({ id: 'ok', worker: 'ok-worker', status: 'success', transcriptRef: 'ok.jsonl' }),
    sampleRun({ id: 'failed', worker: 'failed-worker', status: 'error', error: 'provider exploded', transcriptRef: 'failed.jsonl' }),
  ], dir);
  const list = await (await app.request('/')).text();
  const listBadge = (id: string): string => statusIn(rowFor(list, id));
  const page = async (id: string) => {
    const body = await (await app.request(`/runs/${id}`)).text();
    return {
      header: body.match(/<dt[^>]*>Status<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/)?.[1] ?? '',
      closing: body.match(/<article[^>]*\sdata-message="result"[^>]*>([\s\S]*?)<\/article>\s*<\/div>\s*<\/main>/)?.[1] ?? '',
    };
  };

  const { header: okHeader, closing: ok } = await page('ok');
  const { header: failedHeader, closing: failed } = await page('failed');

  assert.equal(okHeader, listBadge('ok'));
  assert.equal(failedHeader, listBadge('failed'));
  assert.ok(ok.includes(listBadge('ok')), ok);
  assert.equal(textOf(ok), 'success');
  assert.ok(failed.includes(listBadge('failed')), failed);
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

const subagentGroups = (body: string): string[] => detailsBlocks(body, /<details[^>]*\sdata-subagent-group[\s>]/g);
const subagentCalls = (body: string): string[] => body.match(/<section[^>]*\sdata-subagent-call[\s>][\s\S]*?<\/section>/g) ?? [];

test('given a transcript written before subagent calls were recorded, when its transcript is viewed, then each subagent scope still renders grouped and collapsed under its scope and the parent renders ungrouped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-transcripts-'));
  const events: HarnessEvent[] = [
    { type: 'message', role: 'assistant', text: 'parent delegates two reviews', usage, generationId: null },
    { type: 'message', role: 'assistant', text: 'alpha reading the diff', usage, generationId: null, subagent: 'call-alpha' },
    { type: 'message', role: 'assistant', text: 'beta scanning for secrets', usage, generationId: null, subagent: 'call-beta' },
    { type: 'message', role: 'assistant', text: 'alpha report: two findings', usage, generationId: null, subagent: 'call-alpha' },
    { type: 'message', role: 'assistant', text: 'beta report: clean', usage, generationId: null, subagent: 'call-beta' },
    { type: 'message', role: 'assistant', text: 'parent triages the findings', usage, generationId: null },
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
    assert.doesNotMatch(openingTag(group), /\sopen[\s>]/, 'groups are collapsed by default');
  }
  assert.match(alpha, /<summary[^>]*>[\s\S]*call-alpha[\s\S]*2 messages[\s\S]*<\/summary>/, 'a collapsed group names its subagent and how much it did');
  assert.doesNotMatch(body, /data-message="report"/, 'without a recorded subagent result there is no report card');
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
    { type: 'message', role: 'assistant', text: 'parent delegates', usage: { inputTokens: 100, outputTokens: 10 }, generationId: null },
    { type: 'message', role: 'assistant', text: 'child reports', usage: { inputTokens: 700, outputTokens: 40 }, generationId: null, subagent: 'call-alpha' },
    { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
  ];
  writeFileSync(join(dir, 'run-01.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const app = appWith(
    [sampleRun({ id: 'run-01', transcriptRef: 'run-01.jsonl', costUsd: 0.75, inputTokens: 1000, outputTokens: 100 })],
    dir,
  );

  const list = await (await app.request('/')).text();
  const detail = await (await app.request('/runs/run-01')).text();

  assert.match(list, /<td[^>]*\sdata-cost(?=[\s>])[^>]*>\s*\$0\.750000/);
  assert.match(detail, /\$0\.750000/);
  assert.match(detail, /1,000 in \/ 100 out/);
});

const toolCards = (body: string): string[] => detailsBlocks(body, /<details[^>]*\sdata-tool-call[\s>]/g);

const viewTranscript = async (events: HarnessEvent[]): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-transcripts-'));
  writeFileSync(join(dir, 'run-01.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const app = appWith([sampleRun({ id: 'run-01', transcriptRef: 'run-01.jsonl' })], dir);
  return (await app.request('/runs/run-01')).text();
};

test('given a run whose agent made a bash call in a turn with no text, when its run page is viewed, then a collapsed card shows the tool name and command and no empty assistant card renders', async () => {
  const body = await viewTranscript([
    { type: 'message', role: 'user', text: 'run echo forge', usage, generationId: null },
    { type: 'message', role: 'assistant', text: '', usage, generationId: null },
    { type: 'tool_call', id: 'call_1', name: 'bash', arguments: { command: 'echo forge' } },
    { type: 'tool_result', id: 'call_1', isError: false, text: 'forge\n' },
    { type: 'message', role: 'assistant', text: 'it printed forge', usage, generationId: null },
    { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
  ]);

  const cards = toolCards(body);
  assert.equal(cards.length, 1);
  const [card] = cards as [string];
  assert.match(card, /<summary[^>]*>[\s\S]*bash[\s\S]*echo forge[\s\S]*<\/summary>/);
  assert.doesNotMatch(openingTag(card), /\sopen[\s>]/, 'a successful call is collapsed by default');
  assert.doesNotMatch(body, /<header[^>]*>assistant<\/header>\s*<div[^>]*><\/div>/);
  assert.ok(
    body.indexOf('run echo forge') < body.indexOf(card) && body.indexOf(card) < body.indexOf('it printed forge'),
    'the card renders in transcript order',
  );
});

test('given parallel tool calls whose results arrive out of order, when a card is expanded, then it shows its own arguments as pretty json and its own result', async () => {
  const body = await viewTranscript([
    { type: 'message', role: 'assistant', text: 'checking both', usage, generationId: null },
    { type: 'tool_call', id: 'call_1', name: 'read', arguments: { path: 'a.txt', limit: 10 } },
    { type: 'tool_call', id: 'call_2', name: 'read', arguments: { path: 'b.txt' } },
    { type: 'tool_result', id: 'call_2', isError: false, text: 'contents of b' },
    { type: 'tool_result', id: 'call_1', isError: false, text: 'contents of a' },
    { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
  ]);

  const [first, second] = toolCards(body) as [string, string];
  assert.match(first, /<summary[^>]*>[\s\S]*read[\s\S]*a\.txt[\s\S]*<\/summary>/);
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
  assert.doesNotMatch(openingTag(ok), /\sdata-failed[\s>]|\sopen[\s>]/);
  assert.match(openingTag(failed), /\sdata-failed[\s>]/);
  assert.match(openingTag(failed), /\sopen[\s>]/);
  assert.match(failed, /No such file or directory/);
});

test('given a subagent tool call sharing its id with a parent tool call, when the run page is viewed, then the subagent card renders inside its group with its own result and the parent card keeps its own', async () => {
  const body = await viewTranscript([
    { type: 'tool_call', id: 'call_1', name: 'bash', arguments: { command: 'echo parent' } },
    { type: 'tool_result', id: 'call_1', isError: false, text: 'parent output' },
    { type: 'message', role: 'assistant', text: '', usage, generationId: null, subagent: 'call-alpha' },
    { type: 'tool_call', id: 'call_1', name: 'bash', arguments: { command: 'echo alpha' }, subagent: 'call-alpha' },
    { type: 'tool_result', id: 'call_1', isError: false, text: 'alpha output', subagent: 'call-alpha' },
    { type: 'message', role: 'assistant', text: 'alpha report', usage, generationId: null, subagent: 'call-alpha' },
    { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
  ]);

  const [group] = subagentGroups(body) as [string];
  assert.match(group, /<summary[^>]*>[\s\S]*1 message[\s\S]*<\/summary>/);
  const [inner] = toolCards(group) as [string];
  assert.match(inner, /echo alpha[\s\S]*alpha output/);
  assert.doesNotMatch(inner, /parent/);
  assert.doesNotMatch(group, /<header[^>]*>assistant<\/header>\s*<div[^>]*><\/div>/);
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
  assert.match(card, /<summary[^>]*>[\s\S]*bash[\s\S]*<code[^>]*>\{&quot;command&quot;:&quot;echo ffff \.\.\.cut<\/code>/);
  assert.match(card, /<pre[^>]*>\{&quot;command&quot;:&quot;echo ffff\n\.\.\.cut<\/pre>/);
  assert.match(card, /No result recorded\./);
});

test('given a transcript written before tool events were recorded, when its run page is viewed, then every message renders as before, including an empty assistant turn, and no tool card appears', async () => {
  const body = await viewTranscript([
    { type: 'message', role: 'user', text: 'run echo forge', usage, generationId: null },
    { type: 'message', role: 'assistant', text: '', usage, generationId: null },
    { type: 'message', role: 'assistant', text: 'it printed forge', usage, generationId: null },
    { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
  ]);

  assert.equal(toolCards(body).length, 0);
  assert.equal(body.match(/<article[^>]*\sdata-message="assistant"/g)?.length, 2);
  assert.match(body, /<header[^>]*>assistant<\/header>\s*<div[^>]*><\/div>/);
  const result = body.match(/<article[^>]*\sdata-message="result"[^>]*>([\s\S]*?)<\/article>/)?.[1] ?? '';
  assert.match(result, /^<span[^>]*\sdata-status="success"[^>]*>success<\/span>$/);
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
  assert.match(openingTag(first), /\sdata-failed[\s>]/);
  assert.doesNotMatch(first, /second output/);
  assert.match(second, /echo second[\s\S]*second output/);
  assert.doesNotMatch(second, /first output|data-failed/);
});

const delegation: HarnessEvent[] = [
  { type: 'message', role: 'assistant', text: 'Delegating both.', usage, generationId: null },
  { type: 'tool_call', id: 'call_alpha', name: 'subagent', arguments: { task: 'Run echo alpha and report what it printed.' } },
  { type: 'tool_call', id: 'call_beta', name: 'subagent', arguments: { task: 'Say beta.' } },
  { type: 'message', role: 'assistant', text: 'Running it.', usage, generationId: null, subagent: 'call_alpha' },
  { type: 'tool_call', id: 'call_1', name: 'bash', arguments: { command: 'echo alpha' }, subagent: 'call_alpha' },
  { type: 'tool_result', id: 'call_1', isError: false, text: 'alpha\n', subagent: 'call_alpha' },
  { type: 'message', role: 'assistant', text: 'Alpha report: echo alpha printed alpha.', usage, generationId: null, subagent: 'call_alpha' },
  { type: 'message', role: 'assistant', text: 'Beta report: beta.', usage, generationId: null, subagent: 'call_beta' },
  { type: 'tool_result', id: 'call_beta', isError: false, text: 'Beta report: beta.' },
  { type: 'tool_result', id: 'call_alpha', isError: false, text: 'Alpha report: echo alpha printed alpha.' },
  { type: 'message', role: 'assistant', text: 'Both sub-agents reported back.', usage, generationId: null },
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
  const summaryOf = (card: string): string => card.slice(card.indexOf('<summary'), card.indexOf('</summary>'));
  assert.match(summaryOf(alpha), /<span[^>]*\sdata-subagent-task[^>]*\stitle="Run echo alpha and report what it printed\."[^>]*>Run echo alpha and report what it printed\.<\/span>/);
  assert.match(summaryOf(beta), /<span[^>]*\sdata-subagent-task[^>]*\stitle="Say beta\."[^>]*>Say beta\.<\/span>/);
  assert.match(summaryOf(alpha), /2 messages/);
  assert.match(summaryOf(beta), /1 message\b/);
  assert.doesNotMatch(body, /call_alpha|call_beta/);
});

test('given a subagent given a long multi-line task, when its group is expanded, then the whole task is shown and the header keeps it on one line', async () => {
  const task = 'Review the diff.\n\nReport each finding with its file and line.';
  const body = await viewTranscript([
    { type: 'tool_call', id: 'call_alpha', name: 'subagent', arguments: { task } },
    { type: 'message', role: 'assistant', text: 'reviewing', usage, generationId: null, subagent: 'call_alpha' },
    { type: 'tool_result', id: 'call_alpha', isError: false, text: 'clean' },
    { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
  ]);

  const [card] = subagentCalls(body) as [string];
  assert.match(card, /<span[^>]*\sdata-subagent-task[^>]*\stitle="Review the diff\. Report each finding with its file and line\."/);
  assert.match(card, /<header[^>]*>task<\/header>\s*<div[^>]*>\s*<p>Review the diff\.<\/p>\s*<p>Report each finding with its file and line\.<\/p>\s*<\/div>/);
});

test('given a run whose agent spawned two subagents, when a group is viewed, then its report is the subagent tool result, shown once', async () => {
  const body = await viewTranscript(delegation);

  const [alpha, beta] = subagentCalls(body) as [string, string];
  assert.equal(alpha.match(/Alpha report: echo alpha printed alpha\./g)?.length, 1);
  assert.equal(beta.match(/Beta report: beta\./g)?.length, 1);
  assert.match(alpha, /<article[^>]*\sdata-message="report"[^>]*>\s*<header[^>]*>report<\/header>\s*<div[^>]*>\s*<p>Alpha report: echo alpha printed alpha\.<\/p>\s*<\/div>\s*<\/article>\s*<\/div>\s*<\/details>/, 'the report closes the group');
  assert.match(alpha, /<header[^>]*>assistant<\/header>\s*<div[^>]*>\s*<p>Running it\.<\/p>\s*<\/div>/, 'earlier child messages still render');
  assert.equal(body.match(/\sdata-message="report"/g)?.length, 2);
});

test("given a subagent whose final message differs from the result the parent received, when its group is viewed, then both render and the report is the parent's result", async () => {
  const body = await viewTranscript([
    { type: 'tool_call', id: 'call_alpha', name: 'subagent', arguments: { task: 'Summarise the log.' } },
    { type: 'message', role: 'assistant', text: 'full summary', usage, generationId: null, subagent: 'call_alpha' },
    { type: 'tool_result', id: 'call_alpha', isError: false, text: 'full sum\n...cut' },
    { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
  ]);

  const [card] = subagentCalls(body) as [string];
  assert.match(card, /<header[^>]*>assistant<\/header>\s*<div[^>]*>\s*<p>full summary<\/p>\s*<\/div>/);
  assert.match(card, /<header[^>]*>report<\/header>\s*<div[^>]*>\s*<p>full sum\n\.\.\.cut<\/p>\s*<\/div>/);
});

test('given a subagent call that returned an error, when its run page is viewed, then its card is highlighted, its group is open and the error is its report', async () => {
  const body = await viewTranscript([
    { type: 'tool_call', id: 'call_alpha', name: 'subagent', arguments: { task: 'Say alpha.' } },
    { type: 'tool_call', id: 'call_beta', name: 'subagent', arguments: { task: 'Say beta.' } },
    { type: 'message', role: 'assistant', text: 'partial', usage, generationId: null, subagent: 'call_alpha' },
    { type: 'message', role: 'assistant', text: 'beta', usage, generationId: null, subagent: 'call_beta' },
    { type: 'tool_result', id: 'call_alpha', isError: true, text: 'Sub-agent failed: provider error' },
    { type: 'tool_result', id: 'call_beta', isError: false, text: 'beta' },
    { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
  ]);

  const [failed, ok] = subagentCalls(body) as [string, string];
  assert.match(openingTag(failed), /\sdata-failed[\s>]/);
  assert.match(failed, /<span[^>]*\sdata-badge="error"[^>]*>error<\/span>/);
  assert.match(openingTag(subagentGroups(failed)[0] ?? ''), /\sopen[\s>]/);
  assert.match(failed, /<header[^>]*>assistant<\/header>\s*<div[^>]*>\s*<p>partial<\/p>\s*<\/div>/);
  assert.match(failed, /<article[^>]*\sdata-message="error"[^>]*>\s*<header[^>]*>error<\/header>\s*<pre[^>]*>Sub-agent failed: provider error<\/pre>/);
  assert.doesNotMatch(openingTag(ok), /\sdata-failed[\s>]/);
  const [okGroup, ...extraGroups] = subagentGroups(ok);
  assert.deepEqual(extraGroups, []);
  assert.ok(okGroup, 'the successful call has its group');
  assert.doesNotMatch(openingTag(okGroup), /\sopen[\s>]/);
  assert.doesNotMatch(ok, /data-badge=/);
});

test('given a subagent call that never got a result, when its run page is viewed, then its group says no report was recorded', async () => {
  const body = await viewTranscript([
    { type: 'tool_call', id: 'call_alpha', name: 'subagent', arguments: { task: 'Say alpha.' } },
    { type: 'message', role: 'assistant', text: 'working on it', usage, generationId: null, subagent: 'call_alpha' },
    { type: 'result', status: 'error', sessionId: 'sess-abc', error: 'pi exited on signal SIGKILL' },
  ]);

  const [card] = subagentCalls(body) as [string];
  assert.match(card, /working on it[\s\S]*<p[^>]*>No report recorded\.<\/p>/);
  assert.doesNotMatch(card, /data-message="report"/);
});

test('given a provider that reuses a subagent call id across turns, when the run page is viewed, then each child nests under the call that spawned it', async () => {
  const body = await viewTranscript([
    { type: 'tool_call', id: 'call_0', name: 'subagent', arguments: { task: 'First task.' } },
    { type: 'message', role: 'assistant', text: 'first child working', usage, generationId: null, subagent: 'call_0' },
    { type: 'tool_result', id: 'call_0', isError: false, text: 'first report' },
    { type: 'tool_call', id: 'call_0', name: 'subagent', arguments: { task: 'Second task.' } },
    { type: 'message', role: 'assistant', text: 'second child working', usage, generationId: null, subagent: 'call_0' },
    { type: 'tool_result', id: 'call_0', isError: false, text: 'second report' },
    { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
  ]);

  const [first, second] = subagentCalls(body) as [string, string];
  assert.match(first, /First task\.[\s\S]*first child working[\s\S]*first report/);
  assert.doesNotMatch(textOf(first), /second/);
  assert.match(second, /Second task\.[\s\S]*second child working[\s\S]*second report/);
  assert.doesNotMatch(textOf(second), /first/);
});

test('given a subagent given an explicit working directory, when its group is expanded, then the working directory is shown with the task', async () => {
  const body = await viewTranscript([
    { type: 'tool_call', id: 'call_alpha', name: 'subagent', arguments: { task: 'List the files.', cwd: 'repo/src' } },
    { type: 'message', role: 'assistant', text: 'two files', usage, generationId: null, subagent: 'call_alpha' },
    { type: 'tool_result', id: 'call_alpha', isError: false, text: 'two files' },
    { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
  ]);

  const [card] = subagentCalls(body) as [string];
  assert.match(card, /<header[^>]*>cwd<\/header>\s*<pre[^>]*>repo\/src<\/pre>[\s\S]*<header[^>]*>task<\/header>\s*<div[^>]*>\s*<p>List the files\.<\/p>\s*<\/div>/);
});

test('given a subagent call whose arguments carry no task text, when its run page is viewed, then its header and body show the same arguments', async () => {
  const capped = '{"task":"Review the diff\n...cut';
  const body = await viewTranscript([
    { type: 'tool_call', id: 'call_alpha', name: 'subagent', arguments: { cwd: 'repo' } },
    { type: 'tool_call', id: 'call_beta', name: 'subagent', arguments: capped },
    { type: 'message', role: 'assistant', text: 'working', usage, generationId: null, subagent: 'call_alpha' },
    { type: 'message', role: 'assistant', text: 'working', usage, generationId: null, subagent: 'call_beta' },
    { type: 'result', status: 'error', sessionId: 'sess-abc', error: 'pi exited on signal SIGKILL' },
  ]);

  const [alpha, beta] = subagentCalls(body) as [string, string];
  assert.match(alpha, /<span[^>]*\sdata-subagent-task[^>]*\stitle="\{ &quot;cwd&quot;: &quot;repo&quot; \}"/);
  assert.match(alpha, /<header[^>]*>task<\/header>\s*<pre[^>]*>\{\n  &quot;cwd&quot;: &quot;repo&quot;\n\}<\/pre>/);
  assert.match(beta, /<span[^>]*\sdata-subagent-task[^>]*\stitle="\{&quot;task&quot;:&quot;Review the diff \.\.\.cut"/);
  assert.match(beta, /<header[^>]*>task<\/header>\s*<pre[^>]*>\{&quot;task&quot;:&quot;Review the diff\n\.\.\.cut<\/pre>/);
});

test('given a harness whose spawning tool has another name, when its run page is viewed, then children still nest under the call their scope names', async () => {
  const body = await viewTranscript([
    { type: 'tool_call', id: 'toolu_01', name: 'Task', arguments: { task: 'Count the files.' } },
    { type: 'message', role: 'assistant', text: 'three files', usage, generationId: null, subagent: 'toolu_01' },
    { type: 'tool_result', id: 'toolu_01', isError: false, text: 'three files' },
    { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
  ]);

  const [card] = subagentCalls(body) as [string];
  assert.match(card, /<span[^>]*\sdata-tool-name[^>]*>Task<\/span>[\s\S]*Count the files\.[\s\S]*<header[^>]*>report<\/header>\s*<div[^>]*>\s*<p>three files<\/p>\s*<\/div>/);
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
  assert.match(openingTag(card), /\sdata-failed[\s>]/);
  assert.match(openingTag(card), /\sopen[\s>]/);
  assert.match(card, /List the files\.[\s\S]*\.\.\/outside[\s\S]*working directory escapes the run directory/);
});

test('given a tool whose name is longer than a phone-width header, when its run page is viewed, then the card names it in full as a tooltip', async () => {
  const name = 'mcp__github_enterprise__search_pull_request_review_comments';
  const body = await viewTranscript([
    { type: 'tool_call', id: 'call_long', name, arguments: { query: 'retry' } },
    { type: 'tool_result', id: 'call_long', isError: false, text: 'no comments' },
    { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
  ]);

  const [card] = toolCards(body) as [string];
  assert.match(card, new RegExp(`<span[^>]*\\sdata-tool-name[^>]*\\stitle="${name}"[^>]*>${name}</span>`));
});

const messageCard = (body: string, kind: string): string => {
  const match = body.match(new RegExp(`<article[^>]*\\sdata-message="${kind}"[\\s\\S]*?</article>`));
  assert.ok(match, `a ${kind} card renders`);
  return match[0];
};

test('given an agent reply with bold text, a table and a code fence, when the run page is viewed, then they render as formatted markdown', async () => {
  const body = await viewTranscript([
    { type: 'message', role: 'assistant', text: 'This is **bold**.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\nlet x = 1;\n```', usage, generationId: null },
  ]);

  const card = messageCard(body, 'assistant');
  assert.match(card, /<strong>bold<\/strong>/);
  assert.match(card, /<table>[\s\S]*<td>1<\/td>/);
  assert.match(card, /<pre><code>let x = 1;\n<\/code><\/pre>/);
  assert.doesNotMatch(card, /\*\*bold\*\*|\|---/);
});

test('given a subagent task and report containing markdown, when the run page is viewed, then both render as formatted markdown', async () => {
  const body = await viewTranscript([
    { type: 'tool_call', id: 'call_a', name: 'subagent', arguments: { task: 'Check **the** repo' } },
    { type: 'message', role: 'assistant', text: 'working on `it`', usage, generationId: null, subagent: 'call_a' },
    { type: 'tool_result', id: 'call_a', isError: false, text: 'All **clean**', subagent: undefined },
  ] as HarnessEvent[]);

  const [call] = subagentCalls(body) as [string];
  assert.match(messageCard(call, 'task'), /<strong>the<\/strong>/);
  assert.match(messageCard(call, 'report'), /<strong>clean<\/strong>/);
  assert.match(call, /<code>it<\/code>/, 'the subagent own messages render as markdown');
});

test('given an agent message with raw HTML, when the run page is viewed, then the tag is escaped text', async () => {
  const body = await viewTranscript([
    { type: 'message', role: 'assistant', text: 'hi <script>alert(1)</script>', usage, generationId: null },
  ]);

  assert.doesNotMatch(body, /<script>alert/);
  assert.match(messageCard(body, 'assistant'), /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('given an agent message with a markdown image, when the run page is viewed, then no image renders and the markdown shows as text', async () => {
  const body = await viewTranscript([
    { type: 'message', role: 'assistant', text: 'look ![alt](https://evil.example/x.png)', usage, generationId: null },
  ]);

  const card = messageCard(body, 'assistant');
  assert.doesNotMatch(card, /<img/);
  assert.match(card, /!\[alt\]\(https:\/\/evil\.example\/x\.png\)/);
  assert.doesNotMatch(card, /<a /, 'the image url is not linked either');
});

test('given an agent message with safe, unsafe and bare links, when the run page is viewed, then only http, https and mailto links are rendered', async () => {
  const body = await viewTranscript([
    {
      type: 'message',
      role: 'assistant',
      text: '[good](https://example.com/a) [bad](javascript:alert(1)) [mail](mailto:a@example.com) [data](data:text/html;base64,AAAA) https://bare.example.com',
      usage,
      generationId: null,
    },
  ]);

  const card = messageCard(body, 'assistant');
  const anchors = card.match(/<a [^>]*>/g) ?? [];
  assert.equal(anchors.length, 2);
  for (const anchor of anchors) {
    assert.match(anchor, /rel="noopener noreferrer nofollow"/);
  }
  assert.match(card, /<a href="https:\/\/example\.com\/a"/);
  assert.match(card, /<a href="mailto:a@example\.com"/);
  assert.doesNotMatch(card, /href="javascript|href="data|href="https:\/\/bare/);
  assert.match(card, /\[bad\]\(javascript:alert\(1\)\)/);
  assert.match(card, /https:\/\/bare\.example\.com/);
});

test('given tool arguments, results and error text with markdown syntax, when the run page is viewed, then they stay verbatim', async () => {
  const body = await viewTranscript([
    { type: 'tool_call', id: 'c1', name: 'bash', arguments: { command: 'echo **x**' } },
    { type: 'tool_result', id: 'c1', isError: false, text: '**result** `y`' },
    { type: 'tool_call', id: 'c2', name: 'bash', arguments: { command: 'false' } },
    { type: 'tool_result', id: 'c2', isError: true, text: 'boom **failed**' },
  ]);

  assert.match(body, /<pre[^>]*>\*\*result\*\* `y`<\/pre>/);
  assert.match(body, /<pre[^>]*>boom \*\*failed\*\*<\/pre>/);
  assert.match(body, /echo \*\*x\*\*/);
  assert.doesNotMatch(body, /<strong>|<em>/);
});

const viewWithGenerations = async (
  run: Partial<RunRecord>,
  events: HarnessEvent[],
  generations: { generationId: string; subagent: string | null; outcome: 'billed' | 'unbilled' | 'given-up'; cost?: number }[],
): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-transcripts-'));
  writeFileSync(join(dir, 'run-01.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const store = Store.open(':memory:');
  store.insertRun(sampleRun({ id: 'run-01', transcriptRef: 'run-01.jsonl', ...run }));
  for (const { generationId, subagent } of generations) {
    store.recordGeneration({ runId: 'run-01', generationId, subagent, createdAt: '2026-09-21T10:01:00.000Z' });
  }
  const ids = new Map(store.unsettledGenerations().map((g) => [g.generationId, g.id]));
  const lookups: LookupResult[] = [];
  for (const generation of generations) {
    const id = ids.get(generation.generationId)!;
    if (generation.outcome === 'billed') lookups.push({ id, billedCostUsd: generation.cost ?? 0 });
    if (generation.outcome === 'given-up') lookups.push({ id, error: 'not found', givenUp: true });
  }
  store.recordLookups(lookups, '2026-09-21T10:02:00.000Z');
  const app = createApp({ store, transcripts: new FileTranscriptSource(dir), css: '', logo: '' });
  return (await app.request('/runs/run-01')).text();
};

const child = (subagent: string, inputTokens: number, outputTokens: number): HarnessEvent => ({
  type: 'message', role: 'assistant', text: `${subagent} working`, usage: { inputTokens, outputTokens }, generationId: null, subagent,
});

const spawn = (id: string): HarnessEvent => ({ type: 'tool_call', id, name: 'subagent', arguments: { task: `task ${id}` } });

const headerOf = (card: string): string => card.slice(card.indexOf('<summary'), card.indexOf('</summary>'));

test('given a run with two subagents, when its run page is viewed, then each header shows that child\'s own tokens, status and cost', async () => {
  const body = await viewWithGenerations({}, [
    spawn('call_a'), spawn('call_b'),
    child('call_a', 1200, 30), child('call_a', 300, 20), child('call_b', 40, 5),
    { type: 'tool_result', id: 'call_a', isError: false, text: 'a done' },
    { type: 'tool_result', id: 'call_b', isError: false, text: 'b done' },
    { type: 'result', status: 'success', sessionId: null, error: null },
  ], [
    { generationId: 'g1', subagent: 'call_a', outcome: 'billed', cost: 0.25 },
    { generationId: 'g2', subagent: 'call_a', outcome: 'billed', cost: 0.5 },
    { generationId: 'g3', subagent: 'call_b', outcome: 'billed', cost: 0.01 },
    { generationId: 'g4', subagent: null, outcome: 'billed', cost: 9 },
  ]);

  const [a, b] = subagentCalls(body).map((card) => headerOf(card)) as [string, string];
  assert.match(a, /data-status="success"/);
  assert.match(textOf(a), /1,500 in \/ 50 out/);
  assert.match(textOf(a), /\$0\.750000/);
  assert.match(textOf(a), /2 messages/);
  assert.match(b, /data-status="success"/);
  assert.match(textOf(b), /40 in \/ 5 out/);
  assert.match(textOf(b), /\$0\.010000/);
});

test('given subagents with a successful report, an error report, no report in a running run, and no report in an ended run, when run pages are viewed, then their headers show success, error, running and error', async () => {
  const events = (result: HarnessEvent[]): HarnessEvent[] => [spawn('call_a'), child('call_a', 1, 1), ...result];
  const statusOfOnly = async (run: Partial<RunRecord>, result: HarnessEvent[]): Promise<string> => {
    const body = await viewWithGenerations(run, events(result), []);
    return headerOf(subagentCalls(body)[0] ?? '').match(/data-status="([^"]*)"/)?.[1] ?? 'missing';
  };

  assert.equal(await statusOfOnly({}, [{ type: 'tool_result', id: 'call_a', isError: false, text: 'ok' }]), 'success');
  assert.equal(await statusOfOnly({}, [{ type: 'tool_result', id: 'call_a', isError: true, text: 'boom' }]), 'error');
  assert.equal(await statusOfOnly({ status: 'running', endTime: null }, []), 'running');
  assert.equal(await statusOfOnly({ status: 'error' }, []), 'error');
});

test('given subagents whose generations are all billed, partly unbilled and partly given up, when the run page is viewed, then their headers show the billed cost, pending, and the cost so far with the unconfirmed badge', async () => {
  const body = await viewWithGenerations({}, [
    spawn('call_a'), spawn('call_b'), spawn('call_c'),
    child('call_a', 1, 1), child('call_b', 1, 1), child('call_c', 1, 1),
    { type: 'result', status: 'success', sessionId: null, error: null },
  ], [
    { generationId: 'g1', subagent: 'call_a', outcome: 'billed', cost: 0.1 },
    { generationId: 'g2', subagent: 'call_b', outcome: 'billed', cost: 0.2 },
    { generationId: 'g3', subagent: 'call_b', outcome: 'unbilled' },
    { generationId: 'g4', subagent: 'call_c', outcome: 'billed', cost: 0.3 },
    { generationId: 'g5', subagent: 'call_c', outcome: 'given-up' },
  ]);

  const [a, b, c] = subagentCalls(body).map((card) => headerOf(card)) as [string, string, string];
  assert.match(textOf(a), /\$0\.100000/);
  assert.doesNotMatch(a, /data-badge=|pending/);
  assert.match(textOf(b), /pending/);
  assert.match(textOf(c), /\$0\.300000/);
  assert.match(c, /data-badge="unconfirmed"/);
});

test('given a run whose subagent events have no recorded spawning tool call, when its run page is viewed, then that subagent\'s header shows its tokens, status and cost', async () => {
  const body = await viewWithGenerations({ status: 'error' }, [
    child('call_a', 70, 8),
    { type: 'result', status: 'error', sessionId: null, error: 'x' },
  ], [{ generationId: 'g1', subagent: 'call_a', outcome: 'billed', cost: 0.04 }]);

  const [group] = subagentGroups(body) as [string];
  const header = headerOf(group);
  assert.match(header, /data-status="error"/);
  assert.match(textOf(header), /70 in \/ 8 out/);
  assert.match(textOf(header), /\$0\.040000/);
  assert.match(textOf(header), /1 message/);
});

test('given a running run whose subagent has only billed generations so far, when the run page is viewed, then its header shows pending because more may follow', async () => {
  const body = await viewWithGenerations({ status: 'running', endTime: null }, [
    spawn('call_a'), child('call_a', 1, 1),
  ], [{ generationId: 'g1', subagent: 'call_a', outcome: 'billed', cost: 0.1 }]);

  assert.match(textOf(headerOf(subagentCalls(body)[0] ?? '')), /pending/);
});
