import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintHash, Store } from '@forge/shared';
import type { ConfigFingerprint, PullRequestState, RunRecord } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { textOf } from './html.ts';

const SONNET: ConfigFingerprint = {
  model: 'anthropic/claude-sonnet-5.5',
  reasoningEffort: 'high',
  harnessArgs: [],
  harnessVersion: '1.0.0',
  promptTemplate: '3fa2c9d1',
  systemPrompt: 's',
  tools: 't',
  skills: 'k',
};

const GLM: ConfigFingerprint = {
  ...SONNET,
  model: 'z-ai/glm-5',
  reasoningEffort: null,
  promptTemplate: '9b1e77aa',
};

interface Seed {
  id: string;
  fingerprint?: ConfigFingerprint;
  worker?: string;
  repository?: string;
  dispatched?: boolean;
  start?: string;
  seconds: number;
  cost: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  toolCalls: number;
  retries: number;
  pullRequest?: { state: PullRequestState; rework: number };
}

const GITHUB = 'https://github.com/rameezk/';

const runOf = (seed: Seed): RunRecord => {
  const start = seed.start ?? '2026-09-21T10:00:00.000Z';
  const repository = seed.repository ?? 'forge';
  const dispatched = seed.dispatched ?? true;
  return {
    id: seed.id,
    worker: seed.worker ?? 'builder',
    harness: 'pi',
    model: seed.fingerprint?.model ?? 'anthropic/claude-sonnet-5.5',
    reasoningEffort: seed.fingerprint?.reasoningEffort ?? null,
    startTime: start,
    endTime: new Date(Date.parse(start) + seed.seconds * 1000).toISOString(),
    status: 'success',
    costStatus: 'billed',
    costUsd: seed.cost,
    costEstimated: false,
    listPrice: null,
    inputTokens: seed.inputTokens ?? 100,
    outputTokens: 10,
    cacheReadTokens: seed.cacheReadTokens ?? 0,
    cacheWriteTokens: seed.cacheWriteTokens ?? 0,
    transcriptRef: null,
    sessionId: null,
    error: null,
    ticket: dispatched
      ? { repository, number: seed.id.length * 1000 + seed.id.charCodeAt(seed.id.length - 1), url: `${GITHUB}${repository}/issues/1` }
      : null,
    aliveAt: null,
    harnessStartTime: null,
    timeoutSeconds: null,
    exceededLimit: null,
    counters: { toolCalls: seed.toolCalls, failedToolResults: 0, retries: seed.retries, compactions: 0 },
    maxCostUsd: null,
  };
};

const seedStore = (store: Store, seeds: Seed[]): void => {
  for (const seed of seeds) {
    const run = runOf(seed);
    store.insertRun(run);
    if (seed.fingerprint !== undefined) {
      store.recordFingerprint(seed.id, {
        fingerprint: seed.fingerprint,
        hash: fingerprintHash(seed.fingerprint),
        forgeGitSha: null,
        baseCommit: null,
      });
    }
    if (run.ticket === null) continue;
    const started = store.startDispatch(run.ticket, seed.id, run.startTime, 100);
    assert.ok('started' in started);
    store.endDispatch(
      started.started,
      seed.pullRequest === undefined
        ? { state: 'failed', reason: 'no-pull-request', detail: null }
        : { state: 'done', pullRequest: { number: 7, url: `${GITHUB}${run.ticket.repository}/pull/7` } },
      run.endTime!,
    );
    if (seed.pullRequest !== undefined && seed.pullRequest.state !== 'open') {
      store.recordPullRequest(started.started, {
        state: seed.pullRequest.state,
        settledAt: run.endTime,
        rework: seed.pullRequest.rework,
      });
    }
  }
};

const dashboard = (seeds: Seed[]) => {
  const store = Store.open(':memory:');
  seedStore(store, seeds);
  const app = createApp({
    store,
    transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))),
    css: '',
    logo: '',
    idiomorph: '',
    client: '',
  });
  return { store, app, page: async (query = ''): Promise<string> => (await app.request(`/insights${query}`)).text() };
};

type Row = Record<string, string>;

const rowsOf = (page: string): Map<string, Row> =>
  new Map(
    [...page.matchAll(/<tr[^>]*\sdata-cohort="([^"]*)"[^>]*>([\s\S]*?)<\/tr>/g)].map(([, key, body]) => [
      key!,
      Object.fromEntries(
        [...body!.matchAll(/<td[^>]*\sdata-metric="([^"]+)"[^>]*>([\s\S]*?)<\/td>/g)].map(([, name, cell]) => [
          name!,
          textOf(cell!),
        ]),
      ),
    ]),
  );

const COHORT_SEEDS: Seed[] = [
  { id: 'a1', fingerprint: SONNET, seconds: 60, cost: 0.1, cacheReadTokens: 300, toolCalls: 10, retries: 0, pullRequest: { state: 'merged', rework: 1 } },
  { id: 'a2', fingerprint: SONNET, seconds: 120, cost: 0.2, cacheReadTokens: 300, toolCalls: 20, retries: 1, pullRequest: { state: 'merged', rework: 3 } },
  { id: 'a3', fingerprint: SONNET, seconds: 180, cost: 0.3, cacheReadTokens: 300, toolCalls: 30, retries: 1, pullRequest: { state: 'open', rework: 0 } },
  { id: 'a4', fingerprint: SONNET, seconds: 240, cost: 0.4, cacheReadTokens: 300, toolCalls: 40, retries: 2 },
  { id: 'b1', fingerprint: GLM, seconds: 300, cost: 0.5, inputTokens: 200, cacheWriteTokens: 200, toolCalls: 5, retries: 0, pullRequest: { state: 'merged', rework: 0 } },
  { id: 'b2', fingerprint: GLM, seconds: 100, cost: 0.3, inputTokens: 200, cacheWriteTokens: 200, toolCalls: 15, retries: 0, pullRequest: { state: 'closed', rework: 0 } },
];

test('given two cohorts of dispatched workloads, when the insights page is requested, then each cohort row shows its figures', async () => {
  const rows = rowsOf(await dashboard(COHORT_SEEDS).page());

  assert.deepEqual(rows.get(fingerprintHash(SONNET)), {
    label: 'sonnet-5.5 · high · prompt#3fa2',
    workloads: '4',
    opened: '75.0%',
    merged: '50.0%',
    'cost-median': '$0.250000',
    'cost-p90': '$0.370000',
    'cost-per-merged': '$0.500000',
    duration: '2m 30s',
    'cache-hit': '75.0%',
    'tool-calls': '25',
    retries: '1',
    rework: '2',
  });
  assert.deepEqual(rows.get(fingerprintHash(GLM)), {
    label: 'glm-5 · default · prompt#9b1e',
    workloads: '2',
    opened: '100.0%',
    merged: '50.0%',
    'cost-median': '$0.400000',
    'cost-p90': '$0.480000',
    'cost-per-merged': '$0.800000',
    duration: '3m 20s',
    'cache-hit': '0.0%',
    'tool-calls': '10',
    retries: '0',
    rework: '0',
  });
});

const MANUAL_SEEDS: Seed[] = [
  { id: 'd1', fingerprint: SONNET, seconds: 60, cost: 0.1, toolCalls: 10, retries: 0, pullRequest: { state: 'merged', rework: 0 } },
  { id: 'd2', fingerprint: SONNET, seconds: 60, cost: 0.2, toolCalls: 20, retries: 0 },
  { id: 'm1', fingerprint: SONNET, dispatched: false, seconds: 60, cost: 0.6, toolCalls: 60, retries: 0 },
];

test('given a manual workload in a cohort, when the insights page is requested without and then with the manual filter, then it is absent by default and counts only towards efficiency figures with it', async () => {
  const { page } = dashboard(MANUAL_SEEDS);
  const hash = fingerprintHash(SONNET);

  const without = rowsOf(await page()).get(hash)!;
  assert.equal(without['workloads'], '2');
  assert.equal(without['cost-median'], '$0.150000');
  assert.equal(without['tool-calls'], '15');

  const withManual = rowsOf(await page('?manual=1')).get(hash)!;
  assert.equal(withManual['workloads'], '3');
  assert.equal(withManual['cost-median'], '$0.200000');
  assert.equal(withManual['tool-calls'], '20');
  assert.equal(withManual['opened'], '50.0%');
  assert.equal(withManual['merged'], '50.0%');
  assert.equal(withManual['cost-per-merged'], '$0.300000');
});

test('given workloads recorded without a fingerprint, when the insights page is requested, then they appear together as the unknown-config cohort', async () => {
  const rows = rowsOf(
    await dashboard([
      { id: 'u1', seconds: 60, cost: 0.1, toolCalls: 1, retries: 0 },
      { id: 'u2', seconds: 60, cost: 0.2, toolCalls: 1, retries: 0 },
      { id: 'k1', fingerprint: SONNET, seconds: 60, cost: 0.3, toolCalls: 1, retries: 0 },
    ]).page(),
  );

  assert.equal(rows.size, 2);
  assert.equal(rows.get('')!['label'], 'unknown config');
  assert.equal(rows.get('')!['workloads'], '2');
});

const FILTER_SEEDS: Seed[] = [
  { id: 'f1', fingerprint: SONNET, worker: 'builder', repository: 'forge', start: '2026-09-14T10:00:00.000Z', seconds: 60, cost: 0.1, toolCalls: 1, retries: 0 },
  { id: 'f2', fingerprint: SONNET, worker: 'builder', repository: 'forge', start: '2026-09-21T10:00:00.000Z', seconds: 60, cost: 0.2, toolCalls: 1, retries: 0 },
  { id: 'f3', fingerprint: SONNET, worker: 'refiner', repository: 'forge', start: '2026-09-21T10:00:00.000Z', seconds: 60, cost: 0.3, toolCalls: 1, retries: 0 },
  { id: 'f4', fingerprint: SONNET, worker: 'builder', repository: 'site', start: '2026-09-21T10:00:00.000Z', seconds: 60, cost: 0.4, toolCalls: 1, retries: 0 },
];

const selected = (page: string, name: string): string | undefined => {
  const control = page.match(new RegExp(`<(?:select|input)[^>]*\\sname="${name}"[\\s\\S]*?(?=</select>|/>)`))?.[0] ?? '';
  return control.match(/<option[^>]*\sselected[^>]*value="([^"]*)"|<option[^>]*value="([^"]*)"[^>]*\sselected/)?.slice(1).find(Boolean)
    ?? control.match(/\svalue="([^"]*)"/)?.[1];
};

test('given workloads across workers, repositories and weeks, when the insights page is requested with filters in the query string, then only matching workloads count and the filters show as selected', async () => {
  const { page } = dashboard(FILTER_SEEDS);
  const hash = fingerprintHash(SONNET);

  const everything = await page();
  assert.equal(rowsOf(everything).get(hash)!['workloads'], '4');

  const filtered = await page('?worker=builder&repository=forge&from=2026-09-20&to=2026-09-27');
  assert.equal(rowsOf(filtered).get(hash)!['workloads'], '1');
  assert.equal(rowsOf(filtered).get(hash)!['cost-median'], '$0.200000');
  assert.equal(selected(filtered, 'worker'), 'builder');
  assert.equal(selected(filtered, 'repository'), 'forge');
  assert.equal(selected(filtered, 'from'), '2026-09-20');
  assert.equal(selected(filtered, 'to'), '2026-09-27');
});

test('given cohorts of different sizes recorded in any order, when the insights page is requested, then rows run from the largest cohort to the smallest with the unknown-config cohort last', async () => {
  const quick = { seconds: 60, cost: 0.1, toolCalls: 1, retries: 0 };
  const rows = rowsOf(
    await dashboard([
      { id: 'u1', ...quick },
      { id: 'u2', ...quick },
      { id: 'u3', ...quick },
      { id: 'g1', fingerprint: GLM, ...quick },
      { id: 'g2', fingerprint: GLM, ...quick },
      { id: 's1', fingerprint: SONNET, ...quick },
      { id: 's2', fingerprint: SONNET, ...quick },
      { id: 's3', fingerprint: SONNET, ...quick },
      { id: 's4', fingerprint: SONNET, ...quick },
    ]).page(),
  );

  assert.deepEqual([...rows.keys()], [fingerprintHash(SONNET), fingerprintHash(GLM), '']);
});
