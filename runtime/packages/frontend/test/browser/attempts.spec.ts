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
});

test('given the attempts view at desktop width, when it is opened, then every column fits in the table without scrolling sideways', async ({
  dashboard,
  page,
}) => {
  attempt(dashboard.store, 'first', '2026-09-21T10:00:00.000Z', false);
  attempt(dashboard.store, 'second', '2026-09-22T10:00:00.000Z', true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/tickets/forge/42');

  const overflow = await page
    .locator('[data-attempts-table]')
    .evaluate((element) => element.scrollWidth - element.clientWidth);

  expect(overflow).toBe(0);
});

const revise = (store: Store, runId: string, start: string, state: 'ok' | 'error' | 'exceeded' | 'interrupted'): void => {
  store.insertRun({
    id: runId,
    worker: 'reviser',
    harness: 'pi',
    model: fingerprint.model,
    reasoningEffort: 'high',
    startTime: start,
    endTime: new Date(Date.parse(start) + 150_000).toISOString(),
    status: 'success',
    costStatus: 'billed',
    costUsd: 0.4,
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
    maxCostUsd: null,
    exceededLimit: null,
    counters: null,
  });
  const started = store.startRevision(
    { repository: 'forge', number: 7, url: 'https://github.com/rameezk/forge/pull/7' },
    [ticket.number],
    runId,
    start,
    10,
  );
  if (!('started' in started)) throw new Error('revision refused');
  store.endRevision(started.started, state, new Date(Date.parse(start) + 150_000).toISOString());
};

for (const colorScheme of ['light', 'dark'] as const) {
  for (const [name, width] of [['desktop', 1280], ['phone', 375]] as const) {
    test(`given an attempt with several revisions, when the attempts view is shown at ${name} width in ${colorScheme}, then the revisions sit under their attempt and nothing overflows`, async ({
      dashboard,
      page,
    }) => {
      attempt(dashboard.store, 'first', '2026-09-21T10:00:00.000Z', false);
      attempt(dashboard.store, 'second', '2026-09-22T10:00:00.000Z', false);
      revise(dashboard.store, 'rev-1', '2026-09-23T10:00:00.000Z', 'ok');
      revise(dashboard.store, 'rev-2', '2026-09-24T10:00:00.000Z', 'error');
      revise(dashboard.store, 'rev-3', '2026-09-25T10:00:00.000Z', 'exceeded');
      revise(dashboard.store, 'rev-4', '2026-09-26T10:00:00.000Z', 'interrupted');
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/tickets/forge/42');

      await expect(page.locator('[data-revision]')).toHaveCount(4);
      await expect(page.locator('[data-revision="rev-2"] [data-outcome]')).toHaveText('error');
      expect(await page.locator('html').evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
      const table = page.locator('[data-attempts-table]');
      if (width > 1000) {
        expect(await table.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
      }
    });
  }
}
