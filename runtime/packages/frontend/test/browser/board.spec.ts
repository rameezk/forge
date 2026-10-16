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

test.describe('on a desktop screen', () => {
  test.use({ viewport: { width: 1600, height: 800 } });

  test('given the Board on a desktop screen, when it is opened, then the page title sits clear of the header', async ({ dashboard, page }) => {
    dashboard.store.replaceFrontier({ repository: 'forge', github: 'rameezk/forge', polledAt: '2026-09-21T10:00:00.000Z', tickets: [ticket(1)] });

    await page.goto('/');

    const header = await page.getByRole('banner').boundingBox();
    const title = await page.locator('h1').boundingBox();
    expect(title!.y - (header!.y + header!.height)).toBeGreaterThanOrEqual(24);
  });

  test('given the Board on a desktop screen, when it is opened, then the person icon leads the title in every column that has one', async ({ dashboard, page }) => {
    dashboard.store.replaceFrontier({ repository: 'forge', github: 'rameezk/forge', polledAt: '2026-09-21T10:00:00.000Z', tickets: [ticket(1)] });

    await page.goto('/');

    const offsets = await page.locator('[data-column-header]:has([data-person])').evaluateAll((headers) =>
      headers.map((header) => {
        const left = header.getBoundingClientRect().left;
        const icon = header.querySelector('[data-person]')!.getBoundingClientRect();
        const title = header.querySelector('[data-column-title]')!.getBoundingClientRect();
        return { icon: icon.left - left, titleAfterIcon: title.left >= icon.right };
      }),
    );
    expect(offsets).toHaveLength(3);
    expect(offsets.every(({ titleAfterIcon }) => titleAfterIcon)).toBe(true);
    expect(new Set(offsets.map(({ icon }) => Math.round(icon))).size).toBe(1);
  });

  for (const width of ['', '3rem']) {
    test(`given the Board on a desktop screen, when a column title ${width ? 'wraps' : 'fits on one line'}, then the person icon is centred on the title's first line`, async ({ dashboard, page }) => {
      dashboard.store.replaceFrontier({ repository: 'forge', github: 'rameezk/forge', polledAt: '2026-09-21T10:00:00.000Z', tickets: [ticket(1)] });

      await page.goto('/');
      await page.locator('[data-column-title]').evaluateAll((titles, maxWidth) => titles.forEach((title) => title.setAttribute('style', `max-width: ${maxWidth}`)), width);

      const gaps = await page.locator('[data-column-header]:has([data-person])').evaluateAll((headers) =>
        headers.map((header) => {
          const icon = header.querySelector('[data-person]')!.getBoundingClientRect();
          const title = header.querySelector('[data-column-title]')!;
          const range = title.ownerDocument.createRange();
          range.selectNodeContents(title);
          const firstLine = range.getClientRects()[0]!;
          return Math.abs(icon.top + icon.height / 2 - (firstLine.top + firstLine.height / 2));
        }),
      );
      expect(gaps).toHaveLength(3);
      for (const gap of gaps) expect(gap).toBeLessThanOrEqual(1);
    });
  }
});
