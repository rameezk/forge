import { expect, test } from './dashboard.ts';

const ticket = (number: number) => ({
  number,
  title: `Ticket ${number}`,
  url: `https://github.com/rameezk/forge/issues/${number}`,
  parent: null,
  createdAt: '2026-09-20T10:00:00Z',
  forgeReady: false,
  blocked: false,
});

test.describe('on a narrow screen', () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test('given a phone-width screen, when the Board is opened, then all nine columns stay, the board scrolls sideways inside its own container and the page does not', async ({ dashboard, page }) => {
    dashboard.store.replaceFrontier({ repository: 'forge', github: 'rameezk/forge', polledAt: '2026-09-21T10:00:00.000Z', tickets: [ticket(1)] });

    await page.goto('/');

    await expect(page.locator('[data-column-header]')).toHaveCount(9);
    expect(await page.locator('[data-board]').evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await page.locator('html').evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
  });
});
