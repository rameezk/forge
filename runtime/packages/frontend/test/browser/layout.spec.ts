import type { Page } from '@playwright/test';
import type { RunRecord, Store } from '@forge/shared';
import { expect, test } from './dashboard.ts';

const ticket = { repository: 'forge', number: 42, url: 'https://github.com/rameezk/forge/issues/42' };

const PAGES = ['/', '/workloads', '/insights', '/tickets/forge/42', '/runs/run-01'] as const;

const seedRun = (store: Store): void => {
  const run: RunRecord = {
    id: 'run-01',
    worker: 'builder',
    harness: 'pi',
    model: 'anthropic/claude-sonnet-5.5',
    reasoningEffort: null,
    startTime: '2026-09-21T10:00:00.000Z',
    endTime: '2026-09-21T10:10:00.000Z',
    status: 'success',
    costStatus: 'billed',
    costUsd: 1.25,
    costEstimated: false,
    unconfirmedEstimateUsd: 0,
    listPrice: null,
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    transcriptRef: null,
    sessionId: null,
    error: null,
    ticket,
    aliveAt: null,
    harnessStartTime: null,
    timeoutSeconds: null,
    maxCostUsd: null,
    exceededLimit: null,
    counters: null,
  };
  store.insertRun(run);
  const started = store.startDispatch(ticket, run.id, run.startTime, 100);
  if (!('started' in started)) throw new Error('dispatch refused');
  store.endDispatch(started.started, { state: 'done', pullRequest: { number: 7, url: 'https://github.com/rameezk/forge/pull/7' } }, run.endTime!);
};

const left = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((element) => Math.round(element.getBoundingClientRect().left));

const mainBox = (page: Page) =>
  page.locator('main').evaluate((element) => {
    const { left, width } = element.getBoundingClientRect();
    return { left: Math.round(left), width: Math.round(width), viewport: element.ownerDocument.documentElement.clientWidth };
  });

const chrome = async (page: Page) => ({
  logo: await left(page, 'header [data-brand]'),
  nav: await left(page, 'header nav'),
  footer: await page.locator('footer div').evaluate((element) => {
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    return Math.round(range.getBoundingClientRect().left);
  }),
});

test.describe('on a screen wider than 100rem', () => {
  test.use({ viewport: { width: 2000, height: 900 } });

  test('given each page in turn, when it is opened, then the logo, nav and footer text sit at the same horizontal position', async ({
    dashboard,
    page,
  }) => {
    seedRun(dashboard.store);
    const seen: Awaited<ReturnType<typeof chrome>>[] = [];

    for (const path of PAGES) {
      await page.goto(path);
      seen.push(await chrome(page));
    }

    expect(seen[0]!.logo).toBeLessThan(100);
    for (const position of seen) expect(position).toEqual(seen[0]);
  });

  test('given a page other than the Board, when it is opened, then its main content is 100rem wide and centred', async ({
    dashboard,
    page,
  }) => {
    seedRun(dashboard.store);

    for (const path of PAGES.filter((candidate) => candidate !== '/')) {
      await page.goto(path);
      const { left: offset, width, viewport } = await mainBox(page);
      expect(width, path).toBe(1600);
      expect(offset, path).toBe((viewport - 1600) / 2);
    }
  });

  test('given the Board, when it is opened, then its main content spans the full width', async ({ page }) => {
    await page.goto('/');

    const { left: offset, width, viewport } = await mainBox(page);

    expect(offset).toBe(0);
    expect(width).toBe(viewport);
  });
});

test.describe('on a screen narrower than 100rem', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('given each page in turn, when it is opened, then the chrome and content start at the side padding', async ({
    dashboard,
    page,
  }) => {
    seedRun(dashboard.store);

    for (const path of PAGES) {
      await page.goto(path);
      expect(await chrome(page), path).toMatchObject({ logo: 16, footer: 16 });
      expect((await mainBox(page)).left, path).toBe(0);
    }
  });
});
