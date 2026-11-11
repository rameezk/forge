import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import type { RunRecord } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { textOf } from './html.ts';

const aRun = (id: string, worker: string): RunRecord => ({
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
  ticket: { repository: 'forge', number: 7, url: 'https://github.com/rameezk/forge/issues/7' },
  aliveAt: null,
  harnessStartTime: null,
  timeoutSeconds: null,
  maxCostUsd: null,
  exceededLimit: null,
  counters: null,
});

const AT = '2026-11-01T11:00:00.000Z';

const dashboard = (finish: 'valid' | 'invalid' | 'none') => {
  const store = Store.open(':memory:');
  store.insertRun(aRun('failed', 'builder'));
  const dispatch = store.startDispatch({ repository: 'forge', number: 7, url: 'https://github.com/rameezk/forge/issues/7' }, 'failed', '2026-11-01T10:00:00.000Z', 10, null);
  assert.ok('started' in dispatch);
  store.endDispatch(dispatch.started, { state: 'failed', reason: 'check-failed', detail: 'build' }, '2026-11-01T10:03:20.000Z');
  store.insertRun(aRun('diagnosis', 'diagnoser'));
  if (finish !== 'none') {
    const id = store.startDiagnosis('failed', 'diagnosis', AT);
    if (finish === 'valid') {
      store.endDiagnosis(id, 'done', AT, {
        verdict: {
          category: 'skill',
          evidence: [{ turn: 4, note: 'the worker skipped the skill' }, { turn: 9, note: 'then guessed the file' }],
          suggestedFix: 'Name the file to edit in the skill',
        },
      });
    } else {
      store.endDiagnosis(id, 'failed', AT, { detail: 'the agent wrote no diagnosis.json' });
    }
  }
  return createApp({ store, transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))), css: '', logo: '', idiomorph: '', client: '' });
};

const page = async (finish: 'valid' | 'invalid' | 'none', path: string): Promise<string> =>
  (await dashboard(finish).request(path)).text();

const section = (body: string): string => body.match(/<section[^>]*\sdata-diagnosis[\s>][\s\S]*?<\/section>/)?.[0] ?? 'missing';

test('given a failed run with a valid diagnosis, when its page opens, then it shows the category, each piece of evidence linked to its transcript turn, and the suggested fix', async () => {
  const diagnosis = section(await page('valid', '/runs/failed'));
  assert.match(diagnosis, /data-diagnosis-category="skill"/);
  assert.match(textOf(diagnosis), /Skill/);
  const links = [...diagnosis.matchAll(/<a[^>]*href="([^"]*)"[^>]*data-diagnosis-evidence[^>]*>/g)].map((match) => match[1]);
  assert.deepEqual(links, ['/runs/failed/transcript#event-3', '/runs/failed/transcript#event-8']);
  assert.match(textOf(diagnosis), /the worker skipped the skill/);
  assert.match(textOf(diagnosis), /Name the file to edit in the skill/);
});

test('given a failed run whose diagnosis failed, when its page opens, then it says the diagnosis failed and why', async () => {
  const diagnosis = section(await page('invalid', '/runs/failed'));
  assert.match(diagnosis, /data-diagnosis-state="failed"/);
  assert.match(textOf(diagnosis), /diagnosis failed/i);
  assert.match(textOf(diagnosis), /the agent wrote no diagnosis\.json/);
});

test('given a failed run with no diagnosis, when its page opens, then it shows no diagnosis section', async () => {
  assert.equal(section(await page('none', '/runs/failed')), 'missing');
});

test('given a diagnosis run, when its page opens, then it links back to the run it diagnosed', async () => {
  const body = await page('valid', '/runs/diagnosis');
  assert.match(body, /<a[^>]*href="\/runs\/failed"[^>]*data-diagnosis-of/);
});

test('given a diagnosis run, when /workloads is requested, then its row and card carry the kind diagnosis', async () => {
  const body = await page('valid', '/workloads');
  const row = body.match(/<tr[^>]*\sdata-run="diagnosis"[\s\S]*?<\/tr>/)?.[0] ?? 'missing';
  const card = body.match(/<article[^>]*\sdata-run-card="diagnosis"[\s\S]*?<\/article>/)?.[0] ?? 'missing';
  for (const html of [row, card]) {
    assert.match(textOf(html.match(/<div[^>]*\sdata-workload-kind[^>]*>[\s\S]*?<\/div>/)?.[0] ?? ''), /^diagnosis$/);
  }
});
