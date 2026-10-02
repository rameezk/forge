import type { Page } from '@playwright/test';
import type { PolledFrontier, RunRecord, Ticket } from '@forge/shared';
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

const polledFrontier: PolledFrontier = {
  repository: 'forge',
  github: 'rameezk/forge',
  polledAt: '2026-10-02T08:00:00.000Z',
  tickets: [ticket],
};

const openLive = async (page: Page, path: string): Promise<void> => {
  const caughtUp = page.waitForResponse((response) => response.request().resourceType() === 'fetch');
  await page.goto(path);
  await expect(page.getByRole('status')).toHaveText('Live');
  await caughtUp;
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

test('given the runs list loaded before its stream connects, when a run is recorded in between, then the table shows it once the stream connects', async ({
  dashboard,
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/events?*', async (route) => {
    await held;
    await route.continue();
  });
  await page.goto('/');
  await expect(page.getByText('No workloads have run yet.')).toBeVisible();

  dashboard.store.insertRun(runningRun);
  release();

  await expect(page.getByRole('row', { name: /refiner/ })).toBeVisible();
});

test('given the runs list open in a browser, when the dashboard starts serving different assets, then the page reloads to pick them up', async ({
  dashboard,
  page,
}) => {
  await openLive(page, '/');
  await page.route(
    '/',
    async (route) => {
      if (route.request().resourceType() !== 'fetch') return route.fallback();
      const response = await route.fetch();
      const body = (await response.text()).replace(/\/assets\/dashboard-[0-9a-f]+\.css/, '/assets/dashboard-0000000000000000.css');
      await route.fulfill({ response, body });
    },
    { times: 1 },
  );

  dashboard.store.insertRun(runningRun);

  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { unreloaded?: boolean }).unreloaded)).toBeUndefined();
  await expect(page.getByRole('row', { name: /refiner/ })).toBeVisible();
});

test('given the runs list whose refresh after a change failed, when its stream drops and reconnects, then the table catches up', async ({
  dashboard,
  page,
}) => {
  await openLive(page, '/');
  const failed = page.waitForEvent('requestfailed');
  await page.route('/', (route) => (route.request().resourceType() === 'fetch' ? route.abort() : route.fallback()), { times: 1 });

  dashboard.store.insertRun(runningRun);
  await failed;
  await expect(page.getByText('No workloads have run yet.')).toBeVisible();
  dashboard.dropConnections();

  await expect(page.getByRole('row', { name: /refiner/ })).toBeVisible({ timeout: 10_000 });
});

test('given the runs list open in a browser with an extension that added its own stylesheet to the page, when a run is recorded, then the table shows it without a reload', async ({
  dashboard,
  page,
}) => {
  await openLive(page, '/');
  await page.evaluate(() => {
    const doc = (globalThis as unknown as { document: { head: { append(node: unknown): void }; createElement(tag: string): { rel: string; href: string } } }).document;
    const injected = doc.createElement('link');
    injected.rel = 'stylesheet';
    injected.href = 'data:text/css,';
    doc.head.append(injected);
  });

  dashboard.store.insertRun(runningRun);

  await expect(page.getByRole('row', { name: /refiner/ })).toBeVisible();
  await expectNotReloaded(page);
});

test('given the work page open in a browser, when a frontier poll writes new tickets, then the page shows them without a reload', async ({
  dashboard,
  page,
}) => {
  await openLive(page, '/work');

  dashboard.store.replaceFrontier(polledFrontier);

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

test('given the runs list open in a browser, when its stream drops and the reconnect is refused, then the browser stops retrying and the indicator is gone', async ({
  dashboard,
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('Live');
  await page.route('**/events?*', (route) => route.fulfill({ status: 502 }));

  await dashboard.stop();

  await expect(page.getByRole('status')).toHaveCount(0);
});

test.describe('with JS disabled', () => {
  test.use({ javaScriptEnabled: false });

  test('given a browser with JS disabled, when the runs list or the work page is loaded, then it renders fully with no live indicator', async ({
    dashboard,
    page,
  }) => {
    dashboard.store.insertRun(runningRun);
    dashboard.store.replaceFrontier(polledFrontier);

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
