import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import type { DiagnosisCategory, RunRecord } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { textOf } from './html.ts';

const aRun = (id: string, worker: string, number: number): RunRecord => ({
  id,
  worker,
  harness: 'pi',
  model: 'z-ai/glm-5',
  reasoningEffort: null,
  startTime: '2026-11-01T10:00:00.000Z',
  endTime: '2026-11-01T10:03:20.000Z',
  status: 'success',
  costStatus: 'billed',
  costUsd: 0.12,
  costEstimated: false,
  unconfirmedEstimateUsd: 0,
  listPrice: null,
  inputTokens: 10,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  transcriptRef: null,
  sessionId: null,
  error: null,
  ticket: { repository: 'forge', number, url: `https://github.com/rameezk/forge/issues/${number}` },
  aliveAt: null,
  harnessStartTime: null,
  timeoutSeconds: null,
  maxCostUsd: null,
  exceededLimit: null,
  counters: null,
});

const AT = '2026-11-01T11:00:00.000Z';

const verdictOf = (category: DiagnosisCategory) => ({ category, evidence: [{ turn: 1, note: 'seen' }], suggestedFix: 'fix it' });

const dashboard = () => {
  const store = Store.open(':memory:');
  let number = 0;
  const failed = (id: string, worker: string, categories: DiagnosisCategory[]) => {
    number += 1;
    store.insertRun(aRun(id, worker, number));
    const dispatch = store.startDispatch({ repository: 'forge', number, url: `https://github.com/rameezk/forge/issues/${number}` }, id, '2026-11-01T10:00:00.000Z', 10, null);
    assert.ok('started' in dispatch);
    store.endDispatch(dispatch.started, { state: 'failed', reason: 'check-failed', detail: 'build' }, '2026-11-01T10:03:20.000Z');
    categories.forEach((category, index) => {
      store.insertRun(aRun(`${id}-diagnosis-${index}`, 'diagnoser', number));
      store.endDiagnosis(store.startDiagnosis(id, `${id}-diagnosis-${index}`, AT), 'done', AT, { verdict: verdictOf(category) });
    });
  };
  failed('skill-a', 'builder', ['skill']);
  failed('skill-b', 'reviewer', ['skill']);
  failed('forge-a', 'builder', ['forge']);
  failed('reworked', 'builder', ['worker', 'skill']);
  failed('undiagnosed', 'builder', []);
  return createApp({ store, transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))), css: '', logo: '', idiomorph: '', client: '' });
};

const listed = async (query: string): Promise<string[]> => {
  const body = await (await dashboard().request(`/workloads${query}`)).text();
  return [...body.matchAll(/<tr[^>]*\sdata-run="([^"]*)"/g)].map((match) => match[1]!).sort();
};

test('given failed runs diagnosed as skill, skill and forge, when Workloads is filtered to Skill, then only the skill runs are listed', async () => {
  assert.deepEqual(await listed('?category=skill'), ['reworked', 'skill-a', 'skill-b']);
});

test('given a failed run first diagnosed as worker and later as skill, when Workloads is filtered to Worker and then Skill, then only the latest diagnosis counts', async () => {
  assert.ok(!(await listed('?category=worker')).includes('reworked'));
  assert.ok((await listed('?category=skill')).includes('reworked'));
});

test('given a category filter, when combined with the worker filter, then both apply', async () => {
  assert.deepEqual(await listed('?category=skill&worker=reviewer'), ['skill-b']);
});

test('given an unknown category, when Workloads loads, then the filter is ignored', async () => {
  assert.equal((await listed('?category=bogus')).length, 10);
});

test('given Workloads filtered to Forge, when the page renders, then the category select shows Forge and clearing is offered', async () => {
  const body = await (await dashboard().request('/workloads?category=forge')).text();
  assert.match(body, /<option value="forge" selected>Forge<\/option>/);
  assert.match(textOf(body), /Clear filters/);
});

test('given Workloads filtered to Skill, when the status chips render, then their links keep the category', async () => {
  const body = await (await dashboard().request('/workloads?category=skill')).text();
  assert.match(body, /href="\/workloads\?category=skill&amp;status=failed"/);
});
