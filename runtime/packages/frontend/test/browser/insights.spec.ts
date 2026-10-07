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

const workload = (id: string, overrides: Partial<RunRecord> = {}): RunRecord => ({
  id,
  worker: 'builder',
  harness: 'pi',
  model: fingerprint.model,
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
  cacheReadTokens: 300,
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
  counters: { toolCalls: 4, failedToolResults: 0, retries: 0, compactions: 0 },
  ...overrides,
});

const record = (store: Store, run: RunRecord): void => {
  store.insertRun(run);
  store.recordFingerprint(run.id, { fingerprint, hash: fingerprintHash(fingerprint), forgeGitSha: null, baseCommit: null });
};

test('given the insights page open on a cohort, when one of its workloads ends, then the cohort row updates without a reload', async ({
  dashboard,
  page,
}) => {
  record(dashboard.store, workload('done'));
  record(dashboard.store, workload('running', { status: 'running', endTime: null, costStatus: 'pending', costUsd: 0 }));
  await page.goto('/insights?manual=1');
  const row = page.locator('[data-cohort]');
  await expect(row.locator('[data-metric="workloads"]')).toHaveText('1');
  await expect(page.locator('#live')).toHaveText('Live');

  dashboard.store.finalizeRun('running', { status: 'success', sessionId: null, error: null, endTime: '2026-09-21T10:05:00.000Z' });

  await expect(row.locator('[data-metric="workloads"]')).toHaveText('2');
});

test('given the insights page, when it is opened at phone width, then the navigation links to it and the page does not scroll sideways', async ({
  dashboard,
  page,
}) => {
  record(dashboard.store, workload('done'));
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/');

  await page.getByRole('link', { name: 'Insights' }).click();

  await expect(page).toHaveURL(/\/insights$/);
  await expect(page.getByRole('heading', { name: 'Insights' })).toBeVisible();
  expect(await page.locator('html').evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
});

test('given the insights page open on the chart, when a workload ends, then its point appears without a reload', async ({ dashboard, page }) => {
  record(dashboard.store, workload('done'));
  record(dashboard.store, workload('running', { status: 'running', endTime: null, costStatus: 'pending', costUsd: 0 }));
  await page.goto('/insights?manual=1');
  await expect(page.locator('[data-point]')).toHaveCount(1);
  await expect(page.locator('#live')).toHaveText('Live');

  dashboard.store.finalizeRun('running', { status: 'success', sessionId: null, error: null, endTime: '2026-09-21T10:05:00.000Z' });

  await expect(page.locator('[data-point]')).toHaveCount(2);
});

test('given workloads on the insights page, when it is opened at phone width, then the chart fits inside the viewport', async ({ dashboard, page }) => {
  record(dashboard.store, workload('one'));
  record(dashboard.store, workload('two', { startTime: '2026-09-23T10:00:00.000Z', endTime: '2026-09-23T10:02:00.000Z', costUsd: 2 }));
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/insights?manual=1');

  const box = await page.locator('[data-chart="cost"]').boundingBox();

  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  expect(await page.locator('html').evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
});
