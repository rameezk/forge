import { expect, test } from './dashboard.ts';

const ticket = (number: number) => ({
  number,
  title: `Ticket ${number}`,
  url: `https://github.com/rameezk/forge/issues/${number}`,
  parent: null,
  createdAt: '2026-09-20T10:00:00Z',
  forgeReady: false,
  blocked: false,
  forHuman: false,
  blockedBy: [],
});

test.describe('on a narrow screen', () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test('given a phone-width screen, when the Board is opened, then all nine columns stay, the board scrolls sideways inside its own container and the page does not', async ({ dashboard, page }) => {
    dashboard.store.replaceFrontier({ repository: 'forge', github: 'rameezk/forge', polledAt: '2026-09-21T10:00:00.000Z', closed: [], requests: [], tickets: [ticket(1)] });

    await page.goto('/');

    await expect(page.locator('[data-column-header]')).toHaveCount(9);
    expect(await page.locator('[data-board]').evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await page.locator('html').evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
  });

  test('given a phone-width screen, when the Board is opened, then every title fits whole and all headers share one height', async ({ dashboard, page }) => {
    dashboard.store.replaceFrontier({ repository: 'forge', github: 'rameezk/forge', polledAt: '2026-09-21T10:00:00.000Z', closed: [], requests: [], tickets: [ticket(1)] });

    await page.goto('/');

    const headers = await page.locator('[data-column-header]').evaluateAll((elements) =>
      elements.map((header) => ({
        height: Math.round(header.getBoundingClientRect().height),
        titleClipped: header.querySelector('[data-column-title]')!.scrollWidth > header.querySelector('[data-column-title]')!.clientWidth,
      })),
    );
    expect(new Set(headers.map(({ height }) => height)).size).toBe(1);
    expect(headers.some(({ titleClipped }) => titleClipped)).toBe(false);
  });
});

test.describe('on a desktop screen', () => {
  test.use({ viewport: { width: 1600, height: 800 } });

  test('given the Board on a desktop screen, when it is opened, then the page title sits clear of the header', async ({ dashboard, page }) => {
    dashboard.store.replaceFrontier({ repository: 'forge', github: 'rameezk/forge', polledAt: '2026-09-21T10:00:00.000Z', closed: [], requests: [], tickets: [ticket(1)] });

    await page.goto('/');

    await expect.poll(async () => {
      const header = await page.getByRole('banner').boundingBox();
      const title = await page.locator('h1').boundingBox();
      return header && title ? title.y - (header.y + header.height) : -1;
    }).toBeGreaterThanOrEqual(24);
  });

  test('given the Board on a desktop screen, when it is opened, then the headers read as one set, the mockup height: counts flush right, icons 6px left of the count and centred on the title, titles at the left padding', async ({ dashboard, page }) => {
    dashboard.store.replaceFrontier({ repository: 'forge', github: 'rameezk/forge', polledAt: '2026-09-21T10:00:00.000Z', closed: [], requests: [], tickets: [ticket(1)] });

    await page.goto('/');

    const headers = await page.locator('[data-column-header]').evaluateAll((elements) =>
      elements.map((header) => {
        const box = header.getBoundingClientRect();
        const view = header.ownerDocument.defaultView!;
        const style = view.getComputedStyle(header);
        const total = header.querySelector('[data-column-total]')!.getBoundingClientRect();
        const title = header.querySelector('[data-column-title]')!;
        const titleBox = title.getBoundingClientRect();
        const icon = header.querySelector('[data-person]')?.getBoundingClientRect();
        const titleStyle = view.getComputedStyle(title);
        const context = header.ownerDocument.createElement('canvas').getContext('2d')!;
        context.font = `${titleStyle.fontWeight} ${titleStyle.fontSize} ${titleStyle.fontFamily}`;
        const metrics = context.measureText(title.textContent!.toUpperCase());
        const lineHeight = parseFloat(titleStyle.lineHeight);
        const baseline = titleBox.top + (lineHeight - (metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent)) / 2 + metrics.fontBoundingBoxAscent;
        const glyphCentre = baseline - (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2;
        const subtitle = header.querySelector('[data-column-subtitle]')!;
        return {
          height: box.height,
          totalGap: box.right - total.right,
          titleOffset: titleBox.left - box.left - parseFloat(style.paddingLeft),
          titleClipped: title.scrollWidth > title.clientWidth,
          subtitleLines: Math.round(subtitle.getBoundingClientRect().height / parseFloat(view.getComputedStyle(subtitle).lineHeight)),
          icon: icon ? { gap: total.left - icon.right, centre: icon.top + icon.height / 2 - glyphCentre } : null,
        };
      }),
    );
    expect(headers).toHaveLength(9);
    expect(headers.map(({ height }) => Math.round(height))).toEqual(Array(9).fill(51));
    expect(new Set(headers.map(({ totalGap }) => Math.round(totalGap))).size).toBe(1);
    for (const header of headers) {
      expect(header.titleOffset).toBeCloseTo(0, 0);
      expect(header.titleClipped).toBe(false);
      expect(header.subtitleLines).toBe(1);
    }
    const icons = headers.flatMap(({ icon }) => (icon ? [icon] : []));
    expect(icons).toHaveLength(3);
    for (const icon of icons) {
      expect(icon.gap).toBeCloseTo(6, 0);
      expect(Math.abs(icon.centre)).toBeLessThanOrEqual(0.5);
    }
  });
});

test.describe('lane collapsing', () => {
  test.use({ viewport: { width: 1600, height: 800 } });

  const seed = (store: Parameters<Parameters<typeof test>[2]>[0]['dashboard']['store'], tickets: ReturnType<typeof ticket>[]) =>
    store.replaceFrontier({ repository: 'forge', github: 'rameezk/forge', polledAt: '2026-09-21T10:00:00.000Z', closed: [], requests: [], tickets });

  test('given a lane with cards, when its header is clicked and later activated with Enter, then it collapses to its non-zero counts and expands again', async ({ dashboard, page }) => {
    seed(dashboard.store, [ticket(1), ticket(2)]);
    await page.goto('/');
    const header = page.locator('[data-lane-toggle]');

    await expect(page.locator('[data-ticket]:visible')).toHaveCount(2);
    await header.click();
    await expect(page.locator('[data-ticket]:visible')).toHaveCount(0);
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('[data-lane-count]')).toHaveText(['Ready for agent 2']);

    await header.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-ticket]:visible')).toHaveCount(2);
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[data-lane-count]')).toBeHidden();

    await page.keyboard.press('Space');
    await expect(page.locator('[data-ticket]:visible')).toHaveCount(0);
  });

  test('given a collapsed lane, when the page reloads and a live update adds a ticket, then the lane stays collapsed', async ({ dashboard, page }) => {
    seed(dashboard.store, [ticket(1)]);
    await page.goto('/');
    await page.locator('[data-lane-toggle]').click();

    await page.reload();
    await expect(page.locator('[data-lane-toggle]')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('[data-ticket]:visible')).toHaveCount(0);

    seed(dashboard.store, [ticket(1), ticket(2)]);
    await expect(page.locator('[data-lane-count]')).toHaveText(['Ready for agent 2']);
    await expect(page.locator('[data-ticket]:visible')).toHaveCount(0);
  });

  test('given a repository with nothing on the board and no remembered state, when the Board loads, then its lane is collapsed and says it has nothing in flight', async ({ dashboard, page }) => {
    seed(dashboard.store, []);
    await page.goto('/');

    await expect(page.locator('[data-lane-toggle]')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('[data-lane-empty]')).toBeVisible();
    await expect(page.locator('[data-column="done"]')).toBeHidden();
  });
});

const crowd = (store: Parameters<Parameters<typeof test>[2]>[0]['dashboard']['store'], repository: string, count: number, title = 'Ticket') =>
  store.replaceFrontier({
    repository,
    github: `rameezk/${repository}`,
    polledAt: '2026-09-21T10:00:00.000Z',
    closed: [],
    requests: [],
    tickets: Array.from({ length: count }, (_, index) => ({ ...ticket(index + 1), title: `${title} ${index + 1}` })),
  });

test.describe('the board box', () => {
  test.use({ viewport: { width: 1600, height: 800 } });

  test('given a Board with enough tickets to overflow its box, when the box is scrolled down by 500px, then the column header row stays put and the page has not scrolled', async ({ dashboard, page }) => {
    crowd(dashboard.store, 'forge', 40);
    crowd(dashboard.store, 'other', 40);
    await page.goto('/');
    const header = page.locator('[data-column-header]').first();
    const before = await header.boundingBox();

    await page.locator('[data-board]').evaluate((element) => element.scrollTo({ top: 500 }));

    expect(await page.locator('[data-board]').evaluate((element) => element.scrollTop)).toBe(500);
    expect((await header.boundingBox())!.y).toBe(before!.y);
    expect(await page.locator('html').evaluate((element) => element.scrollTop)).toBe(0);
    expect(await page.locator('html').evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0);
  });

  test('given the Board on a desktop screen, when it is opened, then the board box ends at the bottom padding above the footer', async ({ dashboard, page }) => {
    crowd(dashboard.store, 'forge', 40);
    await page.goto('/');

    const gap = await page.locator('[data-board]').evaluate((board) => {
      const view = board.ownerDocument.defaultView!;
      const footer = board.ownerDocument.querySelector('footer')!.getBoundingClientRect();
      const padding = parseFloat(view.getComputedStyle(board.ownerDocument.querySelector('main')!).paddingBottom);
      return { toFooter: footer.top - board.getBoundingClientRect().bottom - padding, footerToViewport: view.innerHeight - footer.bottom };
    });
    expect(gap.toFooter).toBeCloseTo(0, 0);
    expect(gap.footerToViewport).toBeCloseTo(0, 0);
  });

  test('given the board box scrolled down and sideways, when a live update changes a card, then both scroll offsets are unchanged', async ({ dashboard, page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    crowd(dashboard.store, 'forge', 40);
    await page.goto('/');
    await page.locator('[data-board]').evaluate((element) => element.scrollTo({ top: 300, left: 200 }));
    const offsets = () => page.locator('[data-board]').evaluate((element) => [element.scrollTop, element.scrollLeft]);
    expect(await offsets()).toEqual([300, 200]);

    crowd(dashboard.store, 'forge', 40, 'Renamed');

    await expect(page.locator('[data-ticket="1"]')).toContainText('Renamed 1');
    expect(await offsets()).toEqual([300, 200]);
  });

  test('given repository lanes, one expanded and one collapsed, when the Board is opened, then each chevron is vertically centred on its repository name', async ({ dashboard, page }) => {
    crowd(dashboard.store, 'forge', 2);
    crowd(dashboard.store, 'other', 0);
    await page.goto('/');

    const offsets = await page.locator('[data-repository]').evaluateAll((lanes) =>
      lanes.map((lane) => {
        const chevron = lane.querySelector('[data-lane-chevron]')!.getBoundingClientRect();
        const name = lane.querySelector('h2')!.getBoundingClientRect();
        return { collapsed: lane.hasAttribute('data-collapsed'), offset: chevron.top + chevron.height / 2 - (name.top + name.height / 2) };
      }),
    );
    expect(offsets.map(({ collapsed }) => collapsed).sort()).toEqual([false, true]);
    for (const { offset } of offsets) expect(Math.abs(offset)).toBeLessThanOrEqual(0.5);
  });
});

test.describe('the board box on a narrow screen', () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test('given a phone viewport, when the board box is scrolled sideways, then each column header stays above its column and the page does not scroll', async ({ dashboard, page }) => {
    crowd(dashboard.store, 'forge', 40);
    await page.goto('/');

    await page.locator('[data-board]').evaluate((element) => element.scrollTo({ top: 400, left: 300 }));

    const aligned = await page.locator('[data-column-header]').evaluateAll((headers) =>
      headers.map((header) => {
        const key = header.getAttribute('data-column-header');
        const column = header.ownerDocument.querySelector(`[data-column="${key}"]`)!.getBoundingClientRect();
        const box = header.getBoundingClientRect();
        return { left: Math.round(box.left - column.left), width: Math.round(box.width - column.width) };
      }),
    );
    expect(aligned).toEqual(Array(9).fill({ left: 0, width: 0 }));
    expect(await page.locator('html').evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0);
    expect(await page.locator('[data-column-header]').first().evaluate((header) => header.getBoundingClientRect().top)).toBeGreaterThan(0);
  });
});
