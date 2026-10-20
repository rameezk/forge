import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import type { RunRecord } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { openingTag, textOf, tile, tileValue } from './html.ts';

const sampleRun = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  id: 'run-01',
  worker: 'builder',
  harness: 'pi',
  model: 'z-ai/glm-5',
  reasoningEffort: 'high',
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
  cacheReadTokens: 800,
  cacheWriteTokens: 200,
  transcriptRef: null,
  sessionId: null,
  error: null,
  ticket: { repository: 'forge', number: 381, url: 'https://github.com/rameezk/forge/issues/381' },
  aliveAt: null,
  harnessStartTime: null,
  timeoutSeconds: 7200,
  maxCostUsd: null,
  exceededLimit: null,
  counters: { toolCalls: 12, failedToolResults: 2, retries: 1, compactions: 0 },
  ...overrides,
});

const page = async (run: Partial<RunRecord>, seed: (store: Store) => void = () => {}): Promise<string> => {
  const store = Store.open(':memory:');
  store.insertRun(sampleRun(run));
  seed(store);
  const app = createApp({
    store,
    transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))),
    css: '',
    logo: '',
    idiomorph: '',
    client: '',
  });
  return (await app.request('/runs/run-01')).text();
};

const element = (body: string, tag: string, attribute: string): string =>
  body.match(new RegExp(`<${tag}[^>]*\\s${attribute}(?=[\\s>=])[^>]*>[\\s\\S]*?</${tag}>`))?.[0] ?? '';

const details = (body: string): string => element(body, 'details', 'data-run-details');

test('given a finished workload with a ticket and a known cost, when its run page is opened, then a one-line summary shows status, ticket, model, effort and start time and tiles show cost, duration, tokens, cache hit, tool calls and pull request', async () => {
  const body = await page({});

  const summary = element(body, 'p', 'data-summary');
  assert.match(summary, /data-status="success"/);
  assert.match(summary, /href="https:\/\/github.com\/rameezk\/forge\/issues\/381"/);
  assert.match(textOf(summary), /forge #381.*z-ai\/glm-5.*high.*2026/);
  assert.equal(textOf(tile(body, 'cost')), 'Cost $0.123400');
  assert.equal(textOf(tile(body, 'duration')), 'Duration 3m 20s timeout 2h');
  assert.equal(textOf(tile(body, 'tokens')), 'Tokens 4,200 in 850 out');
  assert.equal(textOf(tile(body, 'cache-hit')), 'Cache hit 15.4%');
  assert.equal(textOf(tile(body, 'tool-calls')), 'Tool calls 12 2 failed');
  assert.match(element(body, 'div', 'data-tile="pull-request"'), /Pull request/);
  assert.doesNotMatch(body.replace(details(body), ''), /Harness/);
});

test('given workloads whose cost is pending, estimated, unconfirmed and subscription, when each run page is opened, then the cost tile carries the badges and the list-price equivalent', async () => {
  const pending = await page({ costStatus: 'pending', costUsd: 0.5 });
  const estimated = await page({ costEstimated: true });
  const unconfirmed = await page({ costStatus: 'unconfirmed' });
  const subscription = await page({ costStatus: 'subscription', costUsd: 0 }, (store) => {
    store.recordGeneration({
      runId: 'run-01',
      generationId: 'g1',
      subagent: null,
      kind: 'message',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      estimatedCostUsd: null,
      listPriceEquivalentUsd: 0.25,
      createdAt: '2026-09-21T10:00:01.000Z',
    });
  });

  assert.match(tile(pending, 'cost'), /data-badge="pending"/);
  assert.match(tile(estimated, 'cost'), /data-badge="estimated"/);
  assert.match(tile(unconfirmed, 'cost'), /data-badge="unconfirmed"/);
  assert.match(tile(subscription, 'cost'), /data-badge="subscription"/);
  assert.match(textOf(element(tile(subscription, 'cost'), 'span', 'data-list-price-equivalent')), /\$0\.250000/);
});

test('given a finished workload, when its run page is opened, then Run details is open on wide screens and holds harness, config, providers, breakdown, skills, counters and downloads', async () => {
  const body = await page({ costStatus: 'subscription', costUsd: 0 });

  const section = details(body);
  assert.match(openingTag(section), /\sopen[\s>]/);
  assert.match(openingTag(section), /\sdata-collapsed-on-phone[\s>]/);
  assert.match(textOf(section), /Run details/);
  for (const term of ['Harness', 'Config', 'Providers', 'Cache', 'Retries', 'Compactions']) {
    assert.match(textOf(section), new RegExp(term));
  }
  assert.match(section, /data-harness/);
});

const REPORT = 'The build could not finish.\n\nRan `npm test` and it exited 1.\n\n<script>alert(1)</script>';

const dispatchFailed = (store: Store, detail: string): void => {
  const start = store.startDispatch(
    { repository: 'forge', number: 381, url: 'https://github.com/rameezk/forge/issues/381' },
    'run-01',
    '2026-09-21T10:00:00.000Z',
    10,
  );
  assert.ok('started' in start);
  store.endDispatch(start.started, { state: 'failed', reason: 'no-pull-request', detail }, '2026-09-21T10:03:20.000Z');
};

const reasonOf = (body: string): string => element(body, 'details', 'data-reason');

test('given a failed ticket run whose reason is a multi-paragraph report, when its run page is opened, then the header holds no reason text and a collapsed block below the meta line shows the label and the first line in the failed tone', async () => {
  const body = await page({}, (store) => dispatchFailed(store, REPORT));

  const header = element(body, 'header', 'data-run-head');
  const block = reasonOf(header);
  assert.doesNotMatch(header, /data-outcome-text/);
  assert.ok(header.indexOf('data-summary') < header.indexOf('data-reason'));
  assert.doesNotMatch(openingTag(block), /\sopen[\s>]/);
  assert.match(openingTag(block), /bg-error-soft/);
  assert.match(block, /<summary[^>]*\btruncate\b/);
  assert.match(textOf(element(block, 'summary', 'data-reason-summary')), /^No pull request\s*: The build could not finish\.$/);
});

test('given a failed ticket run whose reason is a report, when the reason block is read, then the full report is rendered markdown with its HTML escaped', async () => {
  const body = await page({}, (store) => dispatchFailed(store, REPORT));

  const block = reasonOf(body);
  assert.match(block, /<code>npm test<\/code>/);
  assert.doesNotMatch(block, /`/);
  assert.match(block, /<p>The build could not finish\.<\/p>/);
  assert.match(block, /&lt;script&gt;/);
  assert.doesNotMatch(block, /<script>/);
});

test('given a ticket run that errored, when its run page is opened, then the error shows only in the reason block and no separate run error box exists', async () => {
  const body = await page({ status: 'error', error: 'provider exploded' }, (store) => dispatchFailed(store, 'provider exploded'));

  assert.equal(body.split('provider exploded').length - 1, 2);
  assert.doesNotMatch(body, /data-run-error/);
  assert.match(reasonOf(body), /provider exploded/);
});

test('given a manual run that errored, when its run page is opened, then the reason block shows the run error', async () => {
  const body = await page({ status: 'error', error: 'harness exited', ticket: null });

  assert.equal(textOf(element(reasonOf(body), 'summary', 'data-reason-summary')), 'harness exited');
  assert.match(openingTag(reasonOf(body)), /bg-error-soft/);
  assert.doesNotMatch(body, /data-run-error/);
});

test('given a run that stopped at its budget and an interrupted one, when their run pages are opened, then the reason block is in the warning tone and the Stopped at notice still shows above Run details', async () => {
  const exceeded = await page({ status: 'exceeded', exceededLimit: 'budget', maxCostUsd: 0.1, error: 'stopped at its budget', ticket: null });
  const interrupted = await page({ status: 'interrupted', error: 'runner stopped without finishing', ticket: null });

  assert.match(openingTag(reasonOf(exceeded)), /bg-warning-soft/);
  assert.doesNotMatch(openingTag(reasonOf(exceeded)), /bg-error-soft/);
  assert.match(element(exceeded, 'p', 'data-exceeded'), /Stopped at/);
  assert.ok(exceeded.indexOf('data-exceeded') < exceeded.indexOf('data-run-details'));
  assert.match(openingTag(reasonOf(interrupted)), /bg-warning-soft/);
});

test('given a run that errored while its dispatch is done, when its run page is opened, then the reason block is in the failed tone and an empty error shows no block', async () => {
  const done = await page({ status: 'error', error: 'provider exploded' }, (store) => {
    const start = store.startDispatch({ repository: 'forge', number: 381, url: 'https://github.com/rameezk/forge/issues/381' }, 'run-01', '2026-09-21T10:00:00.000Z', 10);
    assert.ok('started' in start);
    store.endDispatch(start.started, { state: 'done', pullRequest: { number: 302, url: 'https://github.com/rameezk/forge/pull/302' } }, '2026-09-21T10:03:20.000Z');
  });
  const empty = await page({ status: 'error', error: '  ', ticket: null });

  assert.match(openingTag(reasonOf(done)), /bg-error-soft/);
  assert.doesNotMatch(openingTag(reasonOf(done)), /bg-success-soft/);
  assert.doesNotMatch(empty, /data-reason/);
});

test('given a finished workload, when its run page is opened, then the Run details chevron rotates when its disclosure opens', async () => {
  const body = await page({});

  assert.match(element(details(body), 'summary', 'class'), /\[\[open\]&gt;&amp;\]:before:rotate-90/);
});

test('given a workload with calls, one of them a cache miss, when its run page is opened, then Calls is collapsed and its summary shows the count, total cost, cache hit rate and a miss badge', async () => {
  const body = await page({}, (store) => {
    [
      { cacheRead: 0, cacheWrite: 1000 },
      { cacheRead: 1000, cacheWrite: 100 },
      { cacheRead: 100, cacheWrite: 1200 },
    ].forEach(({ cacheRead, cacheWrite }, index) => {
      store.recordGeneration({
        runId: 'run-01',
        generationId: `g${index}`,
        subagent: null,
        kind: 'message',
        usage: { inputTokens: 0, outputTokens: 10, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite },
        estimatedCostUsd: 0.01,
        createdAt: `2026-09-21T10:00:0${index + 1}.000Z`,
      });
    });
  });

  const section = element(body, 'details', 'data-calls-section');
  assert.doesNotMatch(openingTag(section), /\sopen[\s>]/);
  const summary = element(section, 'summary', 'data-calls-summary');
  assert.match(textOf(summary), /Calls 3 calls \$0\.030000 \d+(\.\d+)?% cache hit/);
  assert.match(summary, /data-badge="cache-miss"/);
  assert.match(section, /data-calls/);
});

test('given a workload with a call that missed the cache, when its run page is opened, then the cache hit tile counts the miss', async () => {
  const body = await page({}, (store) => {
    [1000, 0].forEach((cacheRead, index) => {
      store.recordGeneration({
        runId: 'run-01',
        generationId: `g${index}`,
        subagent: null,
        kind: 'message',
        usage: { inputTokens: 0, outputTokens: 10, cacheReadTokens: cacheRead, cacheWriteTokens: 100 },
        estimatedCostUsd: 0.01,
        createdAt: `2026-09-21T10:00:0${index + 1}.000Z`,
      });
    });
  });

  assert.match(textOf(tile(body, 'cache-hit')), /1 miss$/);
});

test('given an unconfirmed workload whose every generation billing gave up on, when its run page is opened, then the cost tile shows nothing billed beside the unconfirmed estimate, not a bare zero', async () => {
  const body = await page({ costStatus: 'unconfirmed', costUsd: 0, unconfirmedEstimateUsd: 0.36 });

  assert.match(textOf(tile(body, 'cost')), /\$0\.000000 billed \+ ~\$0\.360000 unconfirmed estimate/);
  assert.match(tile(body, 'cost'), /data-badge="unconfirmed"/);
});

test('given a workload with no calls, when its run page is opened, then there is no Calls section', async () => {
  assert.doesNotMatch(await page({}), /data-calls-section/);
});

const seedGeneration = (store: Store, generationId: string, givenUpBecause?: string): void => {
  store.recordGeneration({
    runId: 'run-01',
    generationId,
    subagent: null,
    kind: 'message',
    usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    estimatedCostUsd: null,
    ...(givenUpBecause === undefined ? {} : { givenUpBecause }),
    createdAt: '2026-09-21T10:01:00.000Z',
  });
};

test('given a workload with a generation given up for a non-OpenRouter id, when its run page is opened, then a warning says the harness returned ids that cannot be billed and the unconfirmed badge gives that reason', async () => {
  const body = await page({ costStatus: 'unconfirmed' }, (store) =>
    seedGeneration(store, 'msg_01', '"msg_01" is not an OpenRouter generation id'),
  );

  const warning = element(body, 'p', 'data-unbillable-ids');
  assert.match(warning, /bg-warning-soft/);
  assert.match(textOf(warning), /returned ids that cannot be billed/);
  const badge = element(body, 'span', 'data-badge="unconfirmed"');
  assert.match(badge, /title="[^"]*cannot be billed/);
});

test('given a workload whose only given-up generation has no id, or a subscription workload with req_ ids, when its run page is opened, then no unbillable-ids warning is shown', async () => {
  const unnamed = await page({ costStatus: 'unconfirmed' }, (store) =>
    store.recordGeneration({
      runId: 'run-01',
      generationId: null,
      subagent: null,
      kind: 'message',
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      estimatedCostUsd: null,
      createdAt: '2026-09-21T10:01:00.000Z',
    }),
  );
  const subscription = await page({ costStatus: 'subscription', costUsd: 0 }, (store) =>
    seedGeneration(store, 'req_01'),
  );

  assert.equal(element(unnamed, 'p', 'data-unbillable-ids'), '');
  assert.equal(element(subscription, 'p', 'data-unbillable-ids'), '');
});

test('given a run page, when it is opened, then the back link, title and summary sit in a header spanning both columns above the figures and the transcript', async () => {
  const body = await page({});

  const header = element(body, 'header', 'data-run-head');
  assert.match(openingTag(header), /\blg:col-span-2\b/);
  assert.match(header, /href="\/workloads"/);
  assert.match(header, /<h1/);
  assert.match(header, /data-summary/);
  const figures = element(body, 'div', 'data-figures');
  assert.doesNotMatch(figures, /<h1|data-summary|href="\/workloads"/);
});

test('given a run with no recorded tool calls and no pull request, when its page is requested, then both stat values use the muted italic empty style', async () => {
  const body = await page({ counters: null });

  for (const [name, text] of [['tool-calls', 'not recorded'], ['pull-request', 'none']] as const) {
    const value = tileValue(body, name);
    assert.equal(textOf(value), text);
    assert.match(value, /<span class="font-normal italic text-muted">/);
  }
});
