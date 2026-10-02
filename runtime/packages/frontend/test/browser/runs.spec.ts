import type { RunRecord } from '@forge/shared';
import { expect, test } from './dashboard.ts';

const recordedRun: RunRecord = {
  id: 'run-01',
  worker: 'refiner',
  harness: 'pi',
  model: 'anthropic/claude-opus-4',
  startTime: '2026-09-21T10:00:00.000Z',
  endTime: '2026-09-21T10:03:20.000Z',
  status: 'success',
  costStatus: 'billed',
  costUsd: 0.1234,
  inputTokens: 4200,
  outputTokens: 850,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  transcriptRef: 'run-01.jsonl',
  sessionId: 'sess-abc',
  error: null,
  ticket: null,
};

test('given a dashboard serving a real store with one recorded run, when the runs list is opened, then the run is visible', async ({
  dashboard,
  page,
}) => {
  dashboard.store.insertRun(recordedRun);

  await page.goto('/');

  const row = page.getByRole('row', { name: /refiner/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText('anthropic/claude-opus-4');
  await expect(row).toContainText('$0.1234');
  await expect(row.getByRole('link', { name: 'refiner' })).toHaveAttribute('href', '/runs/run-01');
});

test.describe('with JS disabled', () => {
  test.use({ javaScriptEnabled: false });

  test('given the same dashboard, when the runs list is opened, then it renders fully', async ({ dashboard, page }) => {
    dashboard.store.insertRun(recordedRun);

    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Workloads' })).toBeVisible();
    await expect(page.getByRole('row', { name: /refiner/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /Total/ })).toContainText('$0.1234');
  });
});
