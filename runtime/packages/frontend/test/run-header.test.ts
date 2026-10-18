import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import type { RunRecord } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { openingTag, textOf, tile } from './html.ts';

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

test('given a workload that ended with a long error, when its run page is opened, then the error is a collapsed disclosure with a one-line cut-off summary and the full text inside', async () => {
  const error = `build failed: ${'x'.repeat(400)}`;
  const body = await page({ status: 'error', error });

  const disclosure = element(body, 'details', 'data-run-error');
  assert.doesNotMatch(openingTag(disclosure), /\sopen[\s>]/);
  assert.match(disclosure, /<summary[^>]*\btruncate\b/);
  assert.match(disclosure, /<summary[^>]*before:content-\['▶'\]/);
  assert.match(disclosure, /<summary[^>]*before:content-\['▶'\]/);
  assert.match(disclosure, /bg-error-soft/);
  assert.ok(disclosure.includes(error));
});

test('given an interrupted workload and an exceeded one, when their run pages are opened, then their one-line callouts use the warning tone', async () => {
  const interrupted = await page({ status: 'interrupted', error: 'runner stopped without finishing' });
  const exceeded = await page({ status: 'exceeded', exceededLimit: 'timeout', error: 'stopped after its timeout' });

  const interruptedError = element(interrupted, 'details', 'data-run-error');
  assert.match(interruptedError, /bg-warning-soft/);
  assert.doesNotMatch(interruptedError, /bg-error-soft/);
  assert.match(element(exceeded, 'p', 'data-exceeded'), /bg-warning-soft/);
  assert.doesNotMatch(element(exceeded, 'p', 'data-exceeded'), /bg-error-soft/);
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
