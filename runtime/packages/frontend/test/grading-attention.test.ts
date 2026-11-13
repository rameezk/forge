import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import type { GradingFailure } from '@forge/shared';
import { createApp, FileTranscriptSource } from '../src/index.ts';
import { openingTag, textOf } from './html.ts';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');

const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

const PAGES = ['/', '/workloads', '/insights'];

const RISK = '/insights?tab=risk';

let current = NOW;

const appWith = (seed: (store: Store) => void, gradingRepositories: string[] = ['forge']) => {
  const store = Store.open(':memory:');
  store.recordWatchedPullRequests('forge', [7, 8].map((number) => ({ number, url: `https://github.com/rameezk/forge/pull/${number}`, closes: [10], newestFeedbackAt: null, mergeable: 'MERGEABLE' as const, headSha: `head-${number}`, draft: false, defaultSha: 'main0' })));
  seed(store);
  current = NOW;
  return { store, app: createApp({ store, transcripts: new FileTranscriptSource(mkdtempSync(join(tmpdir(), 'forge-transcripts-'))), css: '', logo: '', idiomorph: '', client: '', gradingRepositories, clock: () => new Date(current), checkIntervalMs: 5 }) };
};

const succeeded = (store: Store, number: number, gradedAt: string): void =>
  store.recordRiskGrade({
    repository: 'forge',
    number,
    headSha: `head-${number}`,
    fingerprint: 'm:abc',
    model: 'm',
    probabilities: { trivial: 0.1, low: 0.7, moderate: 0.15, high: 0.05 },
    score: 0.4,
    confidence: 0.9,
    level: 'low',
    unsettled: false,
    costUsd: 0.01,
    gradedAt,
  });

const failed = (store: Store, category: GradingFailure, attemptedAt: string, message: string = category, number = 7): void =>
  store.recordGradingAttempt({ repository: 'forge', number, headSha: `head-${number}`, attemptedAt, category, message });

const bodyOf = async (app: ReturnType<typeof appWith>['app'], page: string): Promise<string> => (await app.request(page)).text();

const gradingRow = (body: string): string | undefined => body.match(/<[^>]*\sdata-grading-attention[^>]*>[\s\S]*?<\/p>/)?.[0];

const bandOf = (body: string): string | undefined => body.match(/<[^>]*\sdata-attention-band[^>]*>[\s\S]*?<\/section>/)?.[0];

for (const category of ['setup', 'bug'] as const) {
  test(`given the latest grading attempt failed with category ${category}, when any page is requested, then the band shows the red grading row with the message, when grading last succeeded and a See grading link to Insights Risk`, async () => {
    const { app } = appWith((store) => {
      succeeded(store, 8, minutesAgo(6));
      failed(store, category, minutesAgo(1), 'OpenRouter rejected the key');
    });

    for (const page of [...PAGES, RISK]) {
      const body = await bodyOf(app, page);
      const row = gradingRow(bandOf(body) ?? '');
      assert.ok(row, page);
      assert.equal(textOf(row), `Grading needs attention - ${category}: OpenRouter rejected the key. Grading last succeeded 6m 0s ago. See grading`, page);
      assert.match(openingTag(row), /data-grading-failing="[a-z]+"/, page);
      assert.match(openingTag(row), /bg-error-soft/, page);
      assert.match(row, /<a href="\/insights\?tab=risk#grading-status"[^>]*>See grading<\/a>/, page);
    }
  });
}

const assertGradingRow = async (app: ReturnType<typeof appWith>['app'], expected: string | null): Promise<void> => {
  for (const page of [...PAGES, RISK]) {
    const row = gradingRow(bandOf(await bodyOf(app, page)) ?? '');
    assert.equal(row === undefined ? null : textOf(row).replace(/ Grading (?:last succeeded .*|has not succeeded yet)\. See grading$/, ''), expected, page);
  }
};

test('given grading last succeeded 90 minutes ago and every attempt since failed as temporary, when any page is requested, then there is no grading row in the band', async () => {
  const { app } = appWith((store) => {
    succeeded(store, 8, minutesAgo(90));
    failed(store, 'temporary', minutesAgo(60), 'Jev timed out');
    failed(store, 'temporary', minutesAgo(1), 'Jev timed out');
  });

  await assertGradingRow(app, null);
});

test('given grading last succeeded 2 hours 10 minutes ago and every attempt since failed as temporary, when any page is requested, then the band shows the grading row with category temporary', async () => {
  const { app } = appWith((store) => {
    succeeded(store, 8, minutesAgo(130));
    failed(store, 'temporary', minutesAgo(1), 'Jev timed out');
  });

  await assertGradingRow(app, 'Grading needs attention - temporary: Jev timed out.');
});

test('given grading has never succeeded, when the first temporary failure was 2 hours 10 minutes ago, then the band shows the grading row, and with the first failure 90 minutes ago it does not', async () => {
  for (const [firstMinutesAgo, expected] of [[130, 'Grading needs attention - temporary: Jev timed out.'], [90, null]] as const) {
    const { app } = appWith((store) => {
      failed(store, 'temporary', minutesAgo(firstMinutesAgo), 'first');
      failed(store, 'temporary', minutesAgo(1), 'Jev timed out');
    });

    await assertGradingRow(app, expected);
  }
});

test('given a temporary failure under two hours on one pull request and a bug failure on another, when any page is requested, then the band shows the bug row', async () => {
  const { app } = appWith((store) => {
    succeeded(store, 8, minutesAgo(30));
    failed(store, 'bug', minutesAgo(20), 'OpenRouter rejected the request with 400', 7);
    store.recordWatchedPullRequests('forge', [{ number: 9, url: 'https://github.com/rameezk/forge/pull/9', closes: [11], newestFeedbackAt: null, mergeable: 'MERGEABLE', headSha: 'head-9', draft: false, defaultSha: 'main0' }]);
    failed(store, 'temporary', minutesAgo(1), 'Jev timed out', 9);
  });

  await assertGradingRow(app, 'Grading needs attention - bug: OpenRouter rejected the request with 400.');
});

test('given the only failed attempts are too large and declined, when any page is requested, then there is no grading row in the band', async () => {
  const { app } = appWith((store) => {
    failed(store, 'too-large', minutesAgo(600), 'the input does not fit', 7);
    failed(store, 'declined', minutesAgo(600), 'Jev declined to answer', 8);
  });

  await assertGradingRow(app, null);
});

const statusLine = (body: string): string | undefined => body.match(/<[^>]*\sdata-grading-status[^>]*>[\s\S]*?<\/p>/)?.[0];

test('given grading last succeeded 6 minutes ago, when the Board is requested, then it shows no grading status line, and when the Risk tab is requested it shows the muted line under the filters', async () => {
  const { app } = appWith((store) => succeeded(store, 8, minutesAgo(6)));

  assert.equal(statusLine(await bodyOf(app, '/')), undefined);
  const risk = await bodyOf(app, RISK);
  const line = statusLine(risk);
  assert.ok(line);
  assert.equal(textOf(line), 'Grading last succeeded 6m 0s ago');
  assert.match(openingTag(line), /text-muted/);
  assert.match(openingTag(line), /\sid="grading-status"/);
  assert.doesNotMatch(openingTag(line), /data-grading-failing/);
  assert.ok(risk.indexOf('</form>') < risk.indexOf('data-grading-status'));
  assert.ok(risk.indexOf('data-grading-status') < risk.indexOf('<table'));
});

test('given grading has never succeeded, when the Risk tab is requested, then the line says so', async () => {
  const { app } = appWith(() => {});

  assert.equal(textOf(statusLine(await bodyOf(app, RISK)) ?? ''), 'Grading has not succeeded yet');
});

test('given grading last succeeded 90 minutes ago and every attempt since failed as temporary, when the Risk tab is requested, then the line is amber with the category and latest message', async () => {
  const { app } = appWith((store) => {
    succeeded(store, 8, minutesAgo(90));
    failed(store, 'temporary', minutesAgo(1), 'Jev timed out');
  });

  const line = statusLine(await bodyOf(app, RISK));
  assert.ok(line);
  assert.equal(textOf(line), 'Grading last succeeded 1h 30m ago - failing: temporary - Jev timed out');
  assert.match(openingTag(line), /text-warning/);
  assert.match(openingTag(line), /data-grading-failing="temporary"/);
});

test('given a repository with grading off, when the Risk tab is requested, then there is no grading status line', async () => {
  const { app } = appWith(() => {}, []);

  assert.equal(statusLine(await bodyOf(app, RISK)), undefined);
});

test('given an open Board with a temporary failure 1 minute short of two hours and no further attempts, when the two hours pass, then the stream signals a change and the page then carries the grading row', async (t) => {
  const { app } = appWith((store) => {
    succeeded(store, 8, minutesAgo(119));
    failed(store, 'temporary', minutesAgo(10), 'Jev timed out');
  });
  const html = await bodyOf(app, '/');
  assert.equal(gradingRow(html), undefined);
  const version = /<span id="live"[^>]* data-version="([^"]*)"/.exec(html)?.[1]?.replaceAll('&quot;', '"').replaceAll('&amp;', '&');
  const response = await app.request(`/events?page=${encodeURIComponent('/')}&version=${encodeURIComponent(version ?? '')}`);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  t.after(() => reader.cancel());
  const next = reader.read();

  assert.equal(await Promise.race([next, sleep(50).then(() => 'quiet')]), 'quiet');
  current += 2 * 60_000;

  const signal = await Promise.race([next, sleep(500).then(() => 'timeout' as const)]);
  assert.notEqual(signal, 'timeout');
  assert.match(typeof signal === 'string' ? '' : (signal.value ?? ''), /event: change/);
  assert.ok(gradingRow(await bodyOf(app, '/')));
});
