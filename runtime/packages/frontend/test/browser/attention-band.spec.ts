import type { Page } from '@playwright/test';
import type { GradingFailure, RiskGrade, RunRecord, Store } from '@forge/shared';
import { expect, test } from './dashboard.ts';

const LONG_ERROR = `error: builder for '/nix/store/${'a'.repeat(32)}-forge-system.drv' failed with exit code 1\n${'last 20 lines of the log '.repeat(12)}/nix/store/${'b'.repeat(120)}`;

const LONG_MESSAGE = `OpenRouter rejected the request with 400: ${'the prompt was refused '.repeat(12)}${'c'.repeat(120)}`;

const watch = (store: Store, number: number): void =>
  store.recordWatchedPullRequests('forge', [{ number, url: `https://github.com/rameezk/forge/pull/${number}`, closes: [10], newestFeedbackAt: null, mergeable: 'MERGEABLE', headSha: `head-${number}`, draft: false, defaultSha: 'main0' }]);

const fail = (store: Store, category: GradingFailure, message: string, number = 7): void =>
  store.recordGradingAttempt({ repository: 'forge', number, headSha: `head-${number}`, attemptedAt: new Date().toISOString(), category, message });

const grade = (store: Store, number: number, gradedAt: string): void =>
  store.recordRiskGrade({ repository: 'forge', number, headSha: `head-${number}`, fingerprint: 'm:abc', model: 'm', probabilities: { trivial: 0.1, low: 0.7, moderate: 0.15, high: 0.05 }, score: 0.4, confidence: 0.9, level: 'low', unsettled: false, costUsd: 0.01, gradedAt } satisfies RiskGrade);

const sideways = (page: Page): Promise<number> => page.locator('html').evaluate((element) => element.scrollWidth - element.clientWidth);

test('given an open Workloads page with no band, when a bump error and a deploy error are recorded and later cleared, then the band shows each row and later goes without a reload', async ({ dashboard, page }) => {
  await page.goto('/workloads');
  await expect(page.getByRole('status')).toHaveText('Live');
  await page.evaluate(() => {
    (globalThis as unknown as { unreloaded: boolean }).unreloaded = true;
  });
  await expect(page.locator('[data-attention-band]')).toHaveCount(0);

  dashboard.setDeployStatus({ bumpError: 'Resource not accessible by integration' });
  await expect(page.locator('[data-attention-band]')).toContainText('Forge bump: Resource not accessible by integration');

  dashboard.setDeployStatus({ bumpError: 'Resource not accessible by integration', error: 'building the system failed' });
  await expect(page.locator('#deploy-error')).toHaveText('building the system failed');

  dashboard.setDeployStatus({ bumpError: 'Resource not accessible by integration' });
  await expect(page.locator('#deploy-error')).toHaveCount(0);
  await expect(page.locator('[data-attention-band]')).toContainText('Forge bump');

  dashboard.setDeployStatus(null);
  await expect(page.locator('[data-attention-band]')).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as unknown as { unreloaded?: boolean }).unreloaded)).toBe(true);
});

test('given an open Workloads page, when grading fails with a setup problem and the head is later graded, then the grading row appears and clears without a reload', async ({ dashboard, page }) => {
  watch(dashboard.store, 7);
  await page.goto('/workloads');
  await expect(page.getByRole('status')).toHaveText('Live');
  await page.evaluate(() => {
    (globalThis as unknown as { unreloaded: boolean }).unreloaded = true;
  });
  await expect(page.locator('[data-grading-attention]')).toHaveCount(0);

  fail(dashboard.store, 'setup', 'OpenRouter rejected the key');
  await expect(page.locator('[data-grading-attention]')).toContainText('Grading needs attention - setup: OpenRouter rejected the key. Grading has not succeeded yet.');
  await expect(page.getByRole('link', { name: 'See grading' })).toHaveAttribute('href', '/insights?tab=risk#grading-status');

  grade(dashboard.store, 7, new Date().toISOString());
  await expect(page.locator('[data-attention-band]')).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as unknown as { unreloaded?: boolean }).unreloaded)).toBe(true);
});

test('given an open Board and a temporary failure seconds short of two hours with no further attempts, when the two hours pass, then the grading row appears without a reload', async ({ dashboard, page }) => {
  watch(dashboard.store, 7);
  watch(dashboard.store, 8);
  grade(dashboard.store, 8, new Date(Date.now() - 2 * 3_600_000 + 4000).toISOString());
  fail(dashboard.store, 'temporary', 'Jev timed out');
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('Live');
  await page.evaluate(() => {
    (globalThis as unknown as { unreloaded: boolean }).unreloaded = true;
  });
  await expect(page.locator('[data-attention-band]')).toHaveCount(0);

  await expect(page.locator('[data-grading-attention]')).toContainText('Grading needs attention - temporary: Jev timed out.');
  expect(await page.evaluate(() => (globalThis as unknown as { unreloaded?: boolean }).unreloaded)).toBe(true);
});

test('given a deploy error, when the footer link is followed from the Workloads page, then it lands on the row in the band', async ({ dashboard, page }) => {
  dashboard.setDeployStatus({ error: 'building the system failed' });
  await page.goto('/workloads');

  await page.locator('[data-deploy-failed]').click();

  await expect(page).toHaveURL(/\/workloads#deploy-error$/);
  await expect(page.locator('#deploy-error')).toBeInViewport();
});

for (const colorScheme of ['light', 'dark'] as const) {
  for (const [name, width] of [['desktop', 1280], ['phone', 375]] as const) {
    test(`given a long deploy error, a bump error and a long grading failure, when a page is viewed at ${name} width in ${colorScheme}, then the rows wrap in full under the menu bar, scroll away with it and nothing scrolls sideways`, async ({ dashboard, page }) => {
      dashboard.setDeployStatus({ error: LONG_ERROR, bumpError: 'dispatch refused' });
      watch(dashboard.store, 7);
      fail(dashboard.store, 'bug', LONG_MESSAGE);
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: 700 });

      for (const path of ['/workloads', '/']) {
        await page.goto(path);
        const band = page.locator('[data-attention-band]');
        const header = await page.locator('header').boundingBox();
        const box = await band.boundingBox();
        expect(box!.y).toBeCloseTo(header!.y + header!.height, 0);
        expect(box!.width).toBe(width);
        for (const row of await band.locator('p').all()) {
          expect(await row.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
        }
        expect(await sideways(page)).toBe(0);
        await expect(band).toHaveCSS('position', 'static');
      }
    });
  }
}

const finishedRun: RunRecord = {
  id: 'run-01',
  worker: 'refiner',
  harness: 'pi',
  model: 'anthropic/claude-opus-4',
  reasoningEffort: null,
  startTime: '2026-09-21T10:00:00.000Z',
  endTime: '2026-09-21T10:05:00.000Z',
  status: 'success',
  costStatus: 'billed',
  costUsd: 0,
  costEstimated: false,
  unconfirmedEstimateUsd: 0,
  listPrice: null,
  inputTokens: 0,
  outputTokens: 0,
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
};

const poll = (store: Store, repository: string): void =>
  store.replaceFrontier({ repository, github: `rameezk/${repository}`, polledAt: new Date().toISOString(), closed: [], requests: [], tickets: [] });

test('given an open Workloads page, when a repository poll fails and its branch rules fail and both later recover, then the band shows each row and clears without a reload', async ({ dashboard, page }) => {
  poll(dashboard.store, 'forge');
  await page.goto('/workloads');
  await expect(page.getByRole('status')).toHaveText('Live');
  await page.evaluate(() => {
    (globalThis as unknown as { unreloaded: boolean }).unreloaded = true;
  });
  await expect(page.locator('[data-attention-band]')).toHaveCount(0);

  dashboard.store.recordFrontierError({ repository: 'forge', github: 'rameezk/forge', message: 'GitHub answered 401', failedAt: new Date().toISOString() });
  await expect(page.locator('[data-poll-failed]')).toContainText('rameezk/forge: last poll failed');
  await expect(page.locator('[data-poll-failed]')).toContainText('GitHub answered 401');

  dashboard.store.recordBranchRules({ repository: 'forge', github: 'rameezk/forge', failures: ['no approving review'] });
  await expect(page.locator('[data-branch-rules-failing]')).toContainText('no approving review');

  poll(dashboard.store, 'forge');
  dashboard.store.recordBranchRules({ repository: 'forge', github: 'rameezk/forge', failures: [] });
  await expect(page.locator('[data-attention-band]')).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as unknown as { unreloaded?: boolean }).unreloaded)).toBe(true);
});

test('given two repositories, the second with a failed poll, when See lane is followed from a run page, then the Board opens at the second lane', async ({ dashboard, page }) => {
  for (const repository of ['alpha', 'zulu']) poll(dashboard.store, repository);
  dashboard.store.recordFrontierError({ repository: 'zulu', github: 'rameezk/zulu', message: 'GitHub answered 401', failedAt: new Date().toISOString() });
  dashboard.store.insertRun(finishedRun);
  await page.goto('/runs/run-01');
  await page.getByRole('link', { name: 'See lane' }).click();

  await expect(page).toHaveURL(/\/#lane-zulu$/);
  await expect(page.locator('#lane-zulu')).toBeInViewport();
});
