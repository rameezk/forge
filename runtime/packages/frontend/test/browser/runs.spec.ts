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
  costEstimated: false,
  listPrice: null,
  inputTokens: 4200,
  outputTokens: 850,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  transcriptRef: 'run-01.jsonl',
  sessionId: 'sess-abc',
  error: null,
  ticket: null,
  aliveAt: null,
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

test('given a running workload with an estimated cost and a finished one whose cost is both estimated and unconfirmed, when the runs list is opened on a desktop screen, then every cost badge shows without the table scrolling sideways', async ({
  dashboard,
  page,
}) => {
  dashboard.store.insertRun({ ...recordedRun, id: 'running', status: 'running', endTime: null, costStatus: 'pending', costUsd: 1.234567, costEstimated: true });
  dashboard.store.insertRun({ ...recordedRun, id: 'given-up', model: 'anthropic/claude-opus-5.5', costStatus: 'unconfirmed', costUsd: 0.5, costEstimated: true, ticket: { repository: 'forge', number: 158, url: 'https://github.com/rameezk/forge/issues/158' } });

  await page.goto('/');

  await expect(page.locator('[data-badge="estimated"]')).toHaveCount(2);
  await expect(page.locator('[data-badge="unconfirmed"]')).toBeVisible();
  const card = page.locator('table').locator('..');
  expect(await card.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
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
