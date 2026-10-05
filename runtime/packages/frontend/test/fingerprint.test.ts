import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintHash, Store } from '@forge/shared';
import type { ConfigFingerprint, RunRecord } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { textOf } from './html.ts';

const sampleRun = (id: string): RunRecord => ({
  id,
  worker: 'builder',
  harness: 'pi',
  model: 'anthropic/claude-sonnet-5.5',
  reasoningEffort: 'high',
  startTime: '2026-09-21T10:00:00.000Z',
  endTime: '2026-09-21T10:03:00.000Z',
  status: 'success',
  costStatus: 'billed',
  costUsd: 0.1,
  costEstimated: false,
  listPrice: null,
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  transcriptRef: null,
  sessionId: null,
  error: null,
  ticket: null,
  aliveAt: null,
  harnessStartTime: null,
  timeoutSeconds: null,
  exceededLimit: null,
  maxCostUsd: null,
});

const fingerprint: ConfigFingerprint = {
  model: 'anthropic/claude-sonnet-5.5',
  reasoningEffort: 'high',
  harnessArgs: [],
  harnessVersion: '1.0.0',
  promptTemplate: '3fa2c9d1',
  systemPrompt: 's',
  tools: 't',
  skills: 'k',
};

const app = () => {
  const store = Store.open(':memory:');
  store.insertRun(sampleRun('fingerprinted'));
  store.insertRun(sampleRun('legacy'));
  store.recordFingerprint('fingerprinted', {
    fingerprint,
    hash: fingerprintHash(fingerprint),
    forgeGitSha: 'abc1234def5678',
    baseCommit: null,
  });
  return createApp({
    store,
    transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))),
    css: '',
    logo: '',
    idiomorph: '',
    client: '',
  });
};

const configOf = async (id: string): Promise<{ cohort: string; forge: string }> => {
  const page = await (await app().request(`/runs/${id}`)).text();
  const cell = (name: string): string =>
    textOf(page.match(new RegExp(`<dd[^>]*\\sdata-${name}[^>]*>[\\s\\S]*?</dd>`))?.[0] ?? '');
  return { cohort: cell('cohort'), forge: cell('forge-sha') };
};

test('given a workload with a fingerprint, when its run detail page is requested, then it shows the cohort label and forge\'s git sha', async () => {
  assert.deepEqual(await configOf('fingerprinted'), {
    cohort: 'sonnet-5.5 · high · prompt#3fa2',
    forge: 'abc1234',
  });
});

test('given a workload recorded before fingerprints existed, when its run detail page is requested, then it shows the unknown config and no git sha', async () => {
  assert.deepEqual(await configOf('legacy'), { cohort: 'unknown config', forge: '' });
});
