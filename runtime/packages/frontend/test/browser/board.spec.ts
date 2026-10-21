import type { Page } from '@playwright/test';
import type { RunRecord, Store, Ticket } from '@forge/shared';
import { expect, test } from './dashboard.ts';

const ticket = (number: number): Ticket => ({
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

const seed = (store: Store, tickets: Ticket[]) =>
  store.replaceFrontier({ repository: 'forge', github: 'rameezk/forge', polledAt: '2026-09-21T10:00:00.000Z', closed: [], requests: [], tickets });

const spec = (number: number) => ({ number, title: `Spec ${number}`, url: `https://github.com/rameezk/forge/issues/${number}` });

const stagedTickets = (): Ticket[] => [
  ticket(1),
  { ...ticket(2), forHuman: true },
  { ...ticket(3), blocked: true, blockedBy: [9] },
];

const stagesOf = (scope: ReturnType<Page['locator']>) =>
  scope.locator('[data-column]:visible').evaluateAll((columns) =>
    columns.map((column) => ({
      key: column.getAttribute('data-column'),
      header: [column.querySelector('[data-stage-title]'), column.querySelector('[data-stage-count]'), column.querySelector('[data-stage-subtitle]')].flatMap((part) => (part === null ? [] : [part.textContent])).join(' '),
      cards: column.querySelectorAll('[data-ticket]').length,
      cardWidth: Math.round(column.querySelector('[data-ticket]')!.getBoundingClientRect().width),
      columnWidth: Math.round(column.getBoundingClientRect().width),
    })),
  );

test.describe('on a narrow screen', () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test('given a phone-width screen and a lane with cards in some stages, when the Board is opened, then the lane lists only its non-empty stages top to bottom in column order, each with its header and full-width cards, and nothing scrolls sideways', async ({ dashboard, page }) => {
    seed(dashboard.store, stagedTickets());

    await page.goto('/');

    await expect(page.locator('[data-column-header]:visible')).toHaveCount(0);
    const stages = await stagesOf(page.locator('[data-repository="forge"]'));
    expect(stages.map(({ key }) => key)).toEqual(['blocked', 'ready-for-human', 'ready-for-agent']);
    expect(stages.map(({ header }) => header)).toEqual([
      'Blocked 1 Waiting on open blockers',
      'Ready for human 1 Needs a human in the loop',
      'Ready for agent 1 Not handed off yet',
    ]);
    for (const { cardWidth, columnWidth } of stages) {
      expect(columnWidth).toBeGreaterThan(300);
      expect(columnWidth - cardWidth).toBeLessThanOrEqual(20);
    }
    const tops = await page.locator('[data-column]:visible').evaluateAll((columns) => columns.map((column) => Math.round(column.getBoundingClientRect().top)));
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
    expect(new Set(tops).size).toBe(3);
    expect(await page.locator('[data-board]').evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
    expect(await page.locator('html').evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
  });

  test('given a phone-width screen, when the Board is opened, then the person icon marks the human stages and every stage header keeps its title whole', async ({ dashboard, page }) => {
    seed(dashboard.store, stagedTickets());

    await page.goto('/');

    const headers = await page.locator('[data-stage-header]:visible').evaluateAll((elements) =>
      elements.map((header) => ({
        person: header.querySelector('svg') !== null,
        titleClipped: header.querySelector('[data-stage-title]')!.scrollWidth > header.querySelector('[data-stage-title]')!.clientWidth,
      })),
    );
    expect(headers.map(({ person }) => person)).toEqual([false, true, false]);
    expect(headers.some(({ titleClipped }) => titleClipped)).toBe(false);
  });

  test('given a phone-width screen with tickets under two specs plus a loose one, when the Board is opened with Group by Spec, then each spec band appears with No spec last and only that spec\'s non-empty stages appear under a compact title-and-count header', async ({ dashboard, page }) => {
    seed(dashboard.store, [
      { ...ticket(1), parent: spec(20) },
      { ...ticket(2), parent: spec(20), forHuman: true },
      { ...ticket(3), parent: spec(10), blocked: true, blockedBy: [9] },
      ticket(4),
    ]);

    await page.goto('/?group=spec');

    const bands = await page.locator('[data-spec-band]').evaluateAll((elements) => elements.map((band) => band.getAttribute('data-spec-band')));
    expect(bands).toEqual(['10', '20', 'none']);
    const stages = await Promise.all(bands.map((band) => stagesOf(page.locator(`[data-spec-band="${band}"]`))));
    expect(stages.map((list) => list.map(({ key, header }) => [key, header]))).toEqual([
      [['blocked', 'Blocked 1']],
      [['ready-for-human', 'Ready for human 1'], ['ready-for-agent', 'Ready for agent 1']],
      [['ready-for-agent', 'Ready for agent 1']],
    ]);
    expect(await page.locator('html').evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
    expect(await page.locator('[data-board]').evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
  });
});

test.describe('on a 640px screen', () => {
  test.use({ viewport: { width: 640, height: 800 } });

  test('given a 640px viewport, when the Board is opened, then it shows the nine-column layout, not the stacked one', async ({ dashboard, page }) => {
    seed(dashboard.store, stagedTickets());

    await page.goto('/');

    await expect(page.locator('[data-column-header]:visible')).toHaveCount(9);
    await expect(page.locator('[data-stage-header]:visible')).toHaveCount(0);
    const tops = await page.locator('[data-column]:visible').evaluateAll((columns) => columns.map((column) => Math.round(column.getBoundingClientRect().top)));
    expect(tops).toHaveLength(9);
    expect(new Set(tops).size).toBe(1);
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

test.describe('grouping by spec', () => {
  const specTicket = (number: number, spec: number) => ({ ...ticket(number), parent: { number: spec, title: `Spec ${spec}`, url: `https://github.com/rameezk/forge/issues/${spec}` } });

  test('given the Board open at /?group=spec, when a live update arrives, then the Board is still grouped and the control still shows Spec', async ({ dashboard, page }) => {
    seed(dashboard.store, [specTicket(1, 440)]);
    await page.goto('/?group=spec');
    await expect(page.locator('[data-spec-band]')).toHaveCount(1);

    seed(dashboard.store, [specTicket(1, 440), specTicket(2, 455)]);

    await expect(page.locator('[data-spec-band]')).toHaveCount(2);
    await expect(page.locator('[data-group-control] [aria-current]')).toHaveText('Spec');
    await expect(page).toHaveURL(/\/\?group=spec$/);
  });

  test('given the Board, when Spec is chosen in the grouping control, then the URL becomes /?group=spec and the lane shows bands', async ({ dashboard, page }) => {
    seed(dashboard.store, [specTicket(1, 440)]);
    await page.goto('/');

    await page.locator('[data-group-control]').getByText('Spec').click();

    await expect(page).toHaveURL(/\/\?group=spec$/);
    await expect(page.locator('[data-spec-band]')).toHaveCount(1);
  });
});

const crowd = (store: Store, repository: string, count: number, title = 'Ticket') =>
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
    await page.setViewportSize({ width: 1000, height: 800 });
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

  test('given a phone viewport, when the Board is opened, then the box ends above the footer and the lane header fits inside the box beside its scrollbar', async ({ dashboard, page }) => {
    crowd(dashboard.store, 'forge', 40);
    await page.goto('/');

    const fit = await page.locator('[data-board]').evaluate((board) => {
      const document = board.ownerDocument;
      const view = document.defaultView!;
      const footer = document.querySelector('footer')!.getBoundingClientRect();
      const padding = parseFloat(view.getComputedStyle(document.querySelector('main')!).paddingBottom);
      const box = board.getBoundingClientRect();
      const header = document.querySelector('[data-lane-toggle]')!.getBoundingClientRect();
      return { toFooter: footer.top - box.bottom - padding, overhang: header.right - (box.left + board.clientLeft + board.clientWidth) };
    });
    expect(fit.toFooter).toBeCloseTo(0, 0);
    expect(fit.overhang).toBeLessThanOrEqual(0);
  });
});

const GUTTER = 32;
const MIN_COLUMN = 136;

const boardFit = (page: Page) =>
  page.locator('[data-board]').evaluate((board) => {
    const document = board.ownerDocument;
    const box = board.getBoundingClientRect();
    const widths = [...document.querySelectorAll('[data-column-header]')].map((header) => header.getBoundingClientRect().width);
    const inner = (selector: string) => document.querySelector(selector)!.firstElementChild!.getBoundingClientRect().width;
    return {
      viewport: document.documentElement.clientWidth,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      boxWidth: box.width,
      boxOverflow: board.scrollWidth - board.clientWidth,
      columns: widths,
      header: inner('header'),
      footer: inner('footer'),
    };
  });

for (const width of [3440, 1920]) {
  test.describe(`on a ${width}px screen`, () => {
    test.use({ viewport: { width, height: 900 } });

    test(`given a ${width}px viewport, when the Board is opened, then the board, header and footer span the viewport less the gutter, the nine columns share it equally and nothing scrolls sideways`, async ({ dashboard, page }) => {
      seed(dashboard.store, [ticket(1)]);
      await page.goto('/');
      await expect(page.locator('[data-column-header]')).toHaveCount(9);

      const fit = await boardFit(page);

      expect(fit.boxWidth).toBeCloseTo(width - GUTTER, 0);
      expect(fit.header).toBeCloseTo(width, 0);
      expect(fit.footer).toBeCloseTo(width, 0);
      expect(fit.boxOverflow).toBe(0);
      expect(fit.pageOverflow).toBe(0);
      expect(fit.columns).toHaveLength(9);
      for (const column of fit.columns) expect(column).toBeCloseTo(fit.columns[0]!, 0);
      expect(fit.columns[0]).toBeGreaterThan((width - GUTTER) / 9 - 4);
    });
  });
}

test.describe('on a laptop screen', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('given a 1280px viewport, when the Board is opened, then all nine columns are visible and the box does not scroll sideways', async ({ dashboard, page }) => {
    seed(dashboard.store, [ticket(1)]);
    await page.goto('/');
    await expect(page.locator('[data-column-header]')).toHaveCount(9);

    const fit = await boardFit(page);

    expect(fit.boxOverflow).toBe(0);
    expect(fit.pageOverflow).toBe(0);
    for (const column of fit.columns) expect(column).toBeGreaterThanOrEqual(MIN_COLUMN);
  });
});

test.describe('on a narrow laptop screen', () => {
  test.use({ viewport: { width: 1000, height: 800 } });

  test('given a 1000px viewport, when the Board is opened, then the columns keep their minimum width, the box scrolls sideways and the page does not', async ({ dashboard, page }) => {
    seed(dashboard.store, [ticket(1)]);
    await page.goto('/');
    await expect(page.locator('[data-column-header]')).toHaveCount(9);

    const fit = await boardFit(page);

    expect(fit.boxOverflow).toBeGreaterThan(0);
    expect(fit.pageOverflow).toBe(0);
    for (const column of fit.columns) expect(column).toBeCloseTo(MIN_COLUMN, 0);
  });

  test('given a 1000px viewport and the Board grouped by spec, when it is opened, then the band shows and the page does not scroll sideways', async ({ dashboard, page }) => {
    seed(dashboard.store, [{ ...ticket(1), parent: { number: 440, title: 'Spec 440', url: 'https://github.com/rameezk/forge/issues/440' } }]);
    await page.goto('/?group=spec');

    await expect(page.locator('[data-spec-band]')).toHaveCount(1);
    expect((await boardFit(page)).pageOverflow).toBe(0);
  });
});

test.describe('other pages on an ultra-wide screen', () => {
  test.use({ viewport: { width: 3440, height: 900 } });

  for (const path of ['/workloads', '/insights']) {
    test(`given a 3440px viewport, when ${path} is opened, then its content is no wider than 1600px`, async ({ page }) => {
      await page.goto(path);

      const widths = await page.locator('body').evaluate((body) => ['main', 'header > div', 'footer > div'].map((selector) => body.querySelector(selector)!.getBoundingClientRect().width));
      for (const width of widths) expect(width).toBeLessThanOrEqual(1600);
    });
  }
});

const runRecord = (id: string): RunRecord => ({
  id,
  worker: 'builder',
  harness: 'pi',
  model: 'anthropic/claude-sonnet-5.5',
  reasoningEffort: null,
  startTime: '2026-09-21T10:00:00.000Z',
  endTime: null,
  status: 'running',
  costStatus: 'pending',
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
  counters: { toolCalls: 0, failedToolResults: 0, retries: 0, compactions: 0 },
});

const runningDispatch = (store: Store, number: number, runExists: boolean): void => {
  seed(store, [{ ...ticket(number), forgeReady: true }]);
  if (runExists) store.insertRun(runRecord(`run-${number}`));
  const started = store.startDispatch({ repository: 'forge', number, url: `https://github.com/rameezk/forge/issues/${number}` }, `run-${number}`, new Date().toISOString(), 100);
  if (!('started' in started)) throw new Error('dispatch refused');
};

const bottomRight = async (card: ReturnType<Page['locator']>) => {
  const box = (await card.boundingBox())!;
  return { x: box.width - 6, y: box.height - 6 };
};

test.describe('clicking a card', () => {
  test('given a Running card whose run exists, when its blank space is clicked, then the run page opens in the same tab', async ({ dashboard, page }) => {
    runningDispatch(dashboard.store, 7, true);
    await page.goto('/');
    const card = page.locator('[data-ticket="7"]');

    await card.click({ position: await bottomRight(card) });

    await expect(page).toHaveURL(/\/runs\/run-7$/);
    expect(page.context().pages()).toHaveLength(1);
  });

  test('given a Running card, when its #N link is clicked, then the GitHub issue opens in a new tab and the run page does not open', async ({ dashboard, page }) => {
    await page.context().route('https://github.com/**', (route) => route.fulfill({ body: 'github' }));
    runningDispatch(dashboard.store, 7, true);
    await page.goto('/');

    const popup = page.waitForEvent('popup');
    await page.locator('[data-ticket="7"]').getByRole('link', { name: '#7', exact: true }).click();

    expect((await popup).url()).toBe('https://github.com/rameezk/forge/issues/7');
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('given a card on a desktop screen, when it is hovered and later focused with the keyboard, then the cursor is a pointer, the hover state moves no layout and a focus ring shows', async ({ dashboard, page }) => {
    seed(dashboard.store, [ticket(8)]);
    await page.goto('/');
    const card = page.locator('[data-ticket="8"]');
    const link = card.locator('[data-card-link]');
    const look = () => card.evaluate((element) => ({ background: element.ownerDocument.defaultView!.getComputedStyle(element).backgroundColor, box: JSON.stringify(element.getBoundingClientRect()) }));
    const resting = await look();

    await card.hover({ position: await bottomRight(card) });

    expect(await link.evaluate((element) => element.ownerDocument.defaultView!.getComputedStyle(element).cursor)).toBe('pointer');
    const hovered = await look();
    expect(hovered.background).not.toBe(resting.background);
    expect(hovered.box).toBe(resting.box);

    await page.mouse.move(0, 0);
    for (let presses = 0; presses < 60 && !(await link.evaluate((element) => element === element.ownerDocument.activeElement)); presses += 1) await page.keyboard.press('Tab');
    const ring = await link.evaluate((element) => {
      const { outlineStyle, outlineWidth, boxShadow } = element.ownerDocument.defaultView!.getComputedStyle(element);
      return { outline: outlineStyle !== 'none' && parseFloat(outlineWidth) > 0, shadow: boxShadow !== 'none' };
    });
    expect(ring.outline || ring.shadow).toBe(true);
  });

  test('given a Running card linking to the issue because its run does not exist yet, when the run starts and a live update arrives, then the card links to the run', async ({ dashboard, page }) => {
    runningDispatch(dashboard.store, 7, false);
    await page.goto('/');
    const link = page.locator('[data-ticket="7"] [data-card-link]');
    await expect(link).toHaveAttribute('href', 'https://github.com/rameezk/forge/issues/7');
    await expect(link).toHaveAttribute('target', '_blank');

    dashboard.store.insertRun(runRecord('run-7'));

    await expect(link).toHaveAttribute('href', '/runs/run-7');
    await expect(link).toHaveAccessibleName('Open run for #7');
    await expect(link).not.toHaveAttribute('target');
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 800 }, hasTouch: true });

    test('given the Board at phone width, when a card is tapped away from its inner links, then its destination opens', async ({ dashboard, page }) => {
      runningDispatch(dashboard.store, 7, true);
      await page.goto('/');
      const card = page.locator('[data-ticket="7"]');

      await card.tap({ position: await bottomRight(card) });

      await expect(page).toHaveURL(/\/runs\/run-7$/);
    });
  });
});
