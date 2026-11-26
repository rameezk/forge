import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import type { RunRecord } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { textOf } from './html.ts';

const START = '2026-09-21T10:00:00.000Z';
const BEFORE_CUTOFF = new Date('2026-09-21T10:01:00.000Z');
const AFTER_CUTOFF = new Date('2026-09-21T10:05:00.000Z');
const TICKET = { repository: 'forge', number: 42, url: 'https://github.com/rameezk/forge/issues/42' };
const PULL_REQUEST = { repository: 'forge', number: 9, url: 'https://github.com/rameezk/forge/pull/9' };

const runningRun = (id: string, worker: string, ticket: RunRecord['ticket']): RunRecord => ({
  id,
  worker,
  harness: 'pi',
  model: 'anthropic/claude-sonnet-5.5',
  reasoningEffort: null,
  startTime: START,
  endTime: null,
  status: 'running',
  costStatus: 'billed',
  costUsd: 0.1,
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
  ticket,
  aliveAt: null,
  harnessStartTime: null,
  timeoutSeconds: null,
  maxCostUsd: null,
  exceededLimit: null,
  counters: null,
});

const appAt = (store: Store, now: Date) =>
  createApp({ store, transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))), css: '', logo: '', idiomorph: '', client: '', clock: () => now });

const pageText = async (store: Store, now: Date, path: string): Promise<string> => textOf(await (await appAt(store, now).request(path)).text());

test('given a running dispatch last seen at a known instant, when the workloads page is requested with the clock before and after the staleness cutoff, then it is running in the first and interrupted in the second', async () => {
  const store = Store.open(':memory:');
  store.runs.insertRun(runningRun('run-a', 'builder', TICKET));
  assert.ok('started' in store.workloads.startDispatch(TICKET, 'run-a', START, 10, null));

  assert.doesNotMatch(await pageText(store, BEFORE_CUTOFF, '/workloads?range=all'), /interrupted/i);
  assert.match(await pageText(store, AFTER_CUTOFF, '/workloads?range=all'), /interrupted/i);
});

test('given a running revision last seen at a known instant, when the ticket attempts page is requested with the clock before and after the staleness cutoff, then the revision is running in the first and failed in the second', async () => {
  const store = Store.open(':memory:');
  store.runs.insertRun(runningRun('run-a', 'builder', TICKET));
  const dispatch = store.workloads.startDispatch(TICKET, 'run-a', START, 10, null);
  assert.ok('started' in dispatch);
  store.workloads.endDispatch(dispatch.started, { state: 'done', pullRequest: { number: 9, url: PULL_REQUEST.url } }, START);
  store.runs.insertRun(runningRun('run-b', 'reviser', null));
  assert.ok('started' in store.workloads.startRevision(PULL_REQUEST, [TICKET.number], 'run-b', START, 10));

  const revision = (body: string) => body.match(/<tr[^>]*data-revision="run-b"[\s\S]*?<\/tr>/)?.[0] ?? 'missing';
  const early = textOf(revision(await (await appAt(store, BEFORE_CUTOFF).request('/tickets/forge/42')).text()));
  const late = textOf(revision(await (await appAt(store, AFTER_CUTOFF).request('/tickets/forge/42')).text()));

  assert.notEqual(early, 'missing');
  assert.notEqual(early, late);
  assert.match(late, /interrupted|failed/i);
  assert.doesNotMatch(early, /interrupted|failed/i);
});

test('given a running diagnosis last seen at a known instant, when the failed run page is requested with the clock before and after the staleness cutoff, then the diagnosis is running in the first and failed in the second', async () => {
  const store = Store.open(':memory:');
  store.runs.insertRun({ ...runningRun('failed', 'builder', TICKET), status: 'error', endTime: START });
  store.runs.insertRun(runningRun('diagnosis', 'diagnoser', TICKET));
  store.diagnoses.startDiagnosis('failed', 'diagnosis', START);

  const early = await (await appAt(store, BEFORE_CUTOFF).request('/runs/failed')).text();
  const late = await (await appAt(store, AFTER_CUTOFF).request('/runs/failed')).text();

  assert.match(early, /data-diagnosis-running/);
  assert.doesNotMatch(late, /data-diagnosis-running/);
  assert.match(late, /data-diagnosis-failure/);
});
