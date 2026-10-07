import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintHash, Store } from '@forge/shared';
import type { ConfigFingerprint, PullRequestState, RunRecord } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';

export const SONNET: ConfigFingerprint = {
  model: 'anthropic/claude-sonnet-5.5',
  reasoningEffort: 'high',
  harnessArgs: [],
  harnessVersion: '1.0.0',
  promptTemplate: '3fa2c9d1',
  systemPrompt: 's',
  tools: 't',
  skills: 'k',
};

export const GLM: ConfigFingerprint = {
  ...SONNET,
  model: 'z-ai/glm-5',
  reasoningEffort: null,
  promptTemplate: '9b1e77aa',
};

export interface Seed {
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
  providers?: Record<string, number>;
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

const seedGenerations = (store: Store, seed: Seed): void => {
  const providers = Object.entries(seed.providers ?? {});
  providers.forEach(([provider, tokens], index) => {
    store.recordGeneration({
      runId: seed.id,
      generationId: `${seed.id}-gen-${index + 1}`,
      subagent: null,
      usage: { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      estimatedCostUsd: null,
      createdAt: '2026-09-21T10:00:01.000Z',
    });
  });
  const ids = new Map(store.unsettledGenerations().map(({ generationId, id }) => [generationId, id]));
  store.recordLookups(
    providers.map(([provider], index) => ({
      id: ids.get(`${seed.id}-gen-${index + 1}`)!,
      billing: { costUsd: seed.cost / providers.length, usage: null, reasoningTokens: null, provider, model: null },
    })),
    '2026-09-21T10:30:00.000Z',
  );
};

export const seedStore = (store: Store, seeds: Seed[]): void => {
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
    seedGenerations(store, seed);
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

export const dashboard = (seeds: Seed[]) => {
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

