import type { Page } from '@playwright/test';
import { expect, test } from './dashboard.ts';

const LONG_ERROR = `error: builder for '/nix/store/${'a'.repeat(32)}-forge-system.drv' failed with exit code 1\n${'last 20 lines of the log '.repeat(12)}/nix/store/${'b'.repeat(120)}`;

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

test('given a deploy error, when the footer link is followed from the Workloads page, then it lands on the row in the band', async ({ dashboard, page }) => {
  dashboard.setDeployStatus({ error: 'building the system failed' });
  await page.goto('/workloads');

  await page.locator('[data-deploy-failed]').click();

  await expect(page).toHaveURL(/\/workloads#deploy-error$/);
  await expect(page.locator('#deploy-error')).toBeInViewport();
});

for (const colorScheme of ['light', 'dark'] as const) {
  for (const [name, width] of [['desktop', 1280], ['phone', 375]] as const) {
    test(`given a long deploy error and a bump error, when a page is viewed at ${name} width in ${colorScheme}, then the rows wrap in full under the menu bar, scroll away with it and nothing scrolls sideways`, async ({ dashboard, page }) => {
      dashboard.setDeployStatus({ error: LONG_ERROR, bumpError: 'dispatch refused' });
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
