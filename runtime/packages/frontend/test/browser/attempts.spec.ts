import { fingerprintHash } from '@forge/shared';
import type { ConfigFingerprint, RunRecord, Store } from '@forge/shared';
import { expect, test } from './dashboard.ts';

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

const ticket = { repository: 'forge', number: 42, url: 'https://github.com/rameezk/forge/issues/42' };

const attempt = (store: Store, id: string, start: string, merged: boolean): void => {
  const run: RunRecord = {
    id,
    worker: 'builder',
    harness: 'pi',
    model: fingerprint.model,
    reasoningEffort: 'high',
    startTime: start,
    endTime: new Date(Date.parse(start) + 600_000).toISOString(),
    status: 'success',
    costStatus: 'billed',
    costUsd: 1.25,
    costEstimated: false,
    listPrice: null,
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 300,
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
    counters: { toolCalls: 40, failedToolResults: 2, retries: 1, compactions: 0 },
  };
  store.insertRun(run);
  store.recordFingerprint(id, {
    fingerprint,
    hash: fingerprintHash(fingerprint),
    forgeGitSha: null,
    baseCommit: 'aaaaaaa1111111111111111111111111111111aa',
  });
  const started = store.startDispatch(ticket, id, start, 100);
  if (!('started' in started)) throw new Error('dispatch refused');
  store.endDispatch(
    started.started,
    { state: 'done', pullRequest: { number: 7, url: 'https://github.com/rameezk/forge/pull/7' } },
    run.endTime!,
  );
  if (merged) store.recordPullRequest(started.started, { state: 'merged', settledAt: run.endTime, rework: 0 });
};

test('given a run detail page of a dispatched workload, when its attempts link is followed at phone width, then the attempts view lists the attempts without the page scrolling sideways', async ({
  dashboard,
  page,
}) => {
  attempt(dashboard.store, 'first', '2026-09-21T10:00:00.000Z', false);
  attempt(dashboard.store, 'second', '2026-09-22T10:00:00.000Z', true);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/runs/first');

  await page.getByRole('link', { name: 'All attempts' }).click();

  await expect(page).toHaveURL(/\/tickets\/forge\/42$/);
  await expect(page.locator('[data-attempt]')).toHaveCount(2);
  await expect(page.locator('[data-attempt="second"] [data-outcome]')).toHaveText('merged');
  expect(await page.locator('html').evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
  await page.screenshot({ path: process.env['ATTEMPTS_SHOT'] ?? 'test-results/attempts-phone.png' });
});
