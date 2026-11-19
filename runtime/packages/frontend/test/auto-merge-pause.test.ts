import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { textOf } from './html.ts';

const PAGES = ['/', '/workloads', '/insights', '/insights?tab=risk'];

const COHORT = 'typesafe/jev-1.13:abc';

let number = 0;

const settle = (store: Store, outcome: 'merged' | 'closed' | 'auto-merged', fingerprint = COHORT): void => {
  number += 1;
  store.recordRiskGrade({
    repository: 'forge',
    number: 500 + number,
    headSha: `old-${number}`,
    fingerprint,
    model: 'typesafe/jev-1.13',
    probabilities: { trivial: 0.1, low: 0.7, moderate: 0.15, high: 0.05 },
    score: 0.4,
    confidence: 0.9,
    level: 'low',
    uncertain: false,
    costUsd: 0,
    gradedAt: '2026-09-29T09:00:00.000Z',
  });
  const grade = { repository: 'forge', number: 500 + number, headSha: `old-${number}` };
  if (outcome === 'auto-merged') store.markAutoMergeStarted(grade, '2026-09-29T10:00:00.000Z');
  store.settleRiskGrade(grade, outcome === 'closed' ? 'closed' : 'merged', `2026-09-29T10:${String(number % 60).padStart(2, '0')}:00.000Z`);
};

const app = (seed: (store: Store) => void, autoMergeRepositories: string[] = ['forge']) => {
  const store = Store.open(':memory:');
  seed(store);
  return createApp({
    store,
    transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))),
    css: '',
    logo: '',
    idiomorph: '',
    client: '',
    gradingRepositories: ['forge'],
    autoMergeRepositories,
  });
};

const pausedSeed = (store: Store): void => {
  for (let index = 0; index < 3; index += 1) settle(store, 'closed');
  for (let index = 0; index < 17; index += 1) settle(store, 'merged');
};

const row = (body: string): string | undefined => body.match(/<[^>]*\sdata-auto-merge-paused[^>]*>[\s\S]*?<\/p>/)?.[0];

for (const page of PAGES) {
  test(`given human-reviewed grades below the bar in an opted-in repository, when ${page} is requested, then the attention band names the pause with the rate against the bar and links to the Risk tab`, async () => {
    const body = await (await app(pausedSeed).request(page)).text();

    const paused = row(body) ?? '';
    assert.match(textOf(paused), /Auto-merge is paused/);
    assert.match(textOf(paused), /17 of 20/);
    assert.match(textOf(paused), /85\.0%/);
    assert.match(textOf(paused), /90%/);
    assert.match(textOf(paused), /eligible pull requests wait for review/i);
    assert.match(paused, /href="\/insights\?tab=risk#auto-merge"/);
    assert.match(body, /data-attention-band/);
  });
}

test('given a cohort that is warming up, when any page is requested, then the attention band shows no auto-merge entry', async () => {
  const warming = app((store) => {
    for (let index = 0; index < 4; index += 1) settle(store, 'closed');
  });
  for (const page of PAGES) {
    const body = await (await warming.request(page)).text();
    assert.equal(row(body), undefined, page);
  }
});

test('given a live record, or no repository opted in, when any page is requested, then the attention band shows no auto-merge entry', async () => {
  const live = app((store) => {
    for (let index = 0; index < 12; index += 1) settle(store, 'merged');
  });
  const optedOut = app(pausedSeed, []);
  for (const page of PAGES) {
    assert.equal(row(await (await live.request(page)).text()), undefined, page);
    assert.equal(row(await (await optedOut.request(page)).text()), undefined, page);
  }
});
