import type { Page } from '@playwright/test';
import type { RunRecord, Ticket } from '@forge/shared';
import { expect, test } from './dashboard.ts';

const runningRun: RunRecord = {
  id: 'run-01',
  worker: 'refiner',
  harness: 'pi',
  model: 'anthropic/claude-opus-4',
  startTime: '2026-09-21T10:00:00.000Z',
  endTime: null,
  status: 'running',
  costStatus: 'pending',
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  transcriptRef: null,
  sessionId: null,
  error: null,
  ticket: null,
};

const ticket: Ticket = {
  number: 137,
  title: 'Live runs list and work page',
  url: 'https://github.com/rameezk/forge/issues/137',
  parent: { number: 135, title: 'Live dashboard updates' },
  createdAt: '2026-09-30T10:00:00Z',
  forgeReady: false,
  blocked: false,
};

const openLive = async (page: Page, path: string): Promise<void> => {
  await page.goto(path);
  await expect(page.getByRole('status')).toHaveText('Live');
  await page.evaluate(() => {
    (globalThis as unknown as { unreloaded: boolean }).unreloaded = true;
  });
};

const expectNotReloaded = async (page: Page): Promise<void> => {
  await expect(page.getByRole('status')).toHaveText('Live');
  expect(await page.evaluate(() => (globalThis as unknown as { unreloaded?: boolean }).unreloaded)).toBe(true);
};

test('given the runs list open in a browser, when a run is recorded, changes status, and its cost settles, then the table shows each change without a reload', async ({
  dashboard,
  page,
}) => {
  await openLive(page, '/');
  await expect(page.getByText('No workloads have run yet.')).toBeVisible();

  dashboard.store.insertRun(runningRun);
  const row = page.getByRole('row', { name: /refiner/ });
  await expect(row.locator('[data-status]')).toHaveText('running');

  dashboard.store.recordGeneration({
    runId: 'run-01',
    generationId: 'gen-01',
    subagent: null,
    usage: { inputTokens: 4200, outputTokens: 850, cacheReadTokens: 0, cacheWriteTokens: 0 },
    createdAt: '2026-09-21T10:01:00.000Z',
  });
  dashboard.store.finalizeRun('run-01', {
    status: 'success',
    endTime: '2026-09-21T10:03:20.000Z',
    sessionId: 'sess-abc',
    error: null,
  });
  await expect(row.locator('[data-status]')).toHaveText('success');
  await expect(row.locator('[data-cost]')).toHaveText('pending');

  const [unsettled] = dashboard.store.unsettledGenerations();
  dashboard.store.recordLookups(
    [{ id: unsettled!.id, billing: { costUsd: 0.25, usage: null, reasoningTokens: null, provider: 'Anthropic' } }],
    '2026-09-21T10:05:00.000Z',
  );
  await expect(row.locator('[data-cost]')).toHaveText('$0.250000');

  await expectNotReloaded(page);
});

test('given the work page open in a browser, when a frontier poll writes new tickets, then the page shows them without a reload', async ({
  dashboard,
  page,
}) => {
  await openLive(page, '/work');

  dashboard.store.replaceFrontier({
    repository: 'forge',
    github: 'rameezk/forge',
    polledAt: '2026-10-02T08:00:00.000Z',
    tickets: [ticket],
  });

  await expect(page.getByRole('row', { name: /Live runs list and work page/ })).toBeVisible();
  await expectNotReloaded(page);
});

test('given the runs list open in a browser, when the stream is connected, then dropped, then the indicator shows Live, then Reconnecting…', async ({
  dashboard,
  page,
}) => {
  await page.goto('/');
  const indicator = page.getByRole('status');
  await expect(indicator).toHaveText('Live');

  await dashboard.stop();

  await expect(indicator).toHaveText('Reconnecting…');
});

test.describe('with JS disabled', () => {
  test.use({ javaScriptEnabled: false });

  test('given a browser with JS disabled, when the runs list or the work page is loaded, then it renders fully with no live indicator', async ({
    dashboard,
    page,
  }) => {
    dashboard.store.insertRun(runningRun);
    dashboard.store.replaceFrontier({
      repository: 'forge',
      github: 'rameezk/forge',
      polledAt: '2026-10-02T08:00:00.000Z',
      tickets: [ticket],
    });

    await page.goto('/');
    await expect(page.getByRole('row', { name: /refiner/ })).toBeVisible();
    await expect(page.getByRole('status')).toHaveCount(0);
    await expect(page.getByText('Live', { exact: true })).toHaveCount(0);

    await page.goto('/work');
    await expect(page.getByRole('row', { name: /Live runs list and work page/ })).toBeVisible();
    await expect(page.getByRole('status')).toHaveCount(0);
    await expect(page.getByText('Live', { exact: true })).toHaveCount(0);
  });
});
