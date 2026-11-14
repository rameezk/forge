import { fingerprintHash } from '@forge/shared';
import type { ConfigFingerprint, RunRecord, Store } from '@forge/shared';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './dashboard.ts';

const fingerprint: ConfigFingerprint = {
  model: 'anthropic/claude-sonnet-5.5',
  reasoningEffort: 'high',
  harnessArgs: [],
  harnessVersion: '1.0.0',
  promptTemplate: '3fa2c9d1',
  systemPrompt: 's',
  tools: 't',
  skills: 'k',
};

const ticket = { repository: 'forge', number: 42, url: 'https://github.com/rameezk/forge/issues/42' };

const attempt = (store: Store, id: string, start: string, merged: boolean): void => {
  const run: RunRecord = {
    id,
    worker: 'builder',
    harness: 'pi',
    model: fingerprint.model,
    reasoningEffort: 'high',
    startTime: start,
    endTime: new Date(Date.parse(start) + 600_000).toISOString(),
    status: 'success',
    costStatus: 'billed',
    costUsd: 1.25,
    costEstimated: false,
    unconfirmedEstimateUsd: 0,
    listPrice: null,
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 300,
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
    counters: { toolCalls: 40, failedToolResults: 2, retries: 1, compactions: 0 },
  };
  store.insertRun(run);
  store.recordFingerprint(id, {
    fingerprint,
    hash: fingerprintHash(fingerprint),
    forgeGitSha: null,
    baseCommit: 'aaaaaaa1111111111111111111111111111111aa',
  });
  const started = store.startDispatch(ticket, id, start, 100, null);
  if (!('started' in started)) throw new Error('dispatch refused');
  store.endDispatch(
    started.started,
    { state: 'done', pullRequest: { number: 7, url: 'https://github.com/rameezk/forge/pull/7' } },
    run.endTime!,
  );
  if (merged) store.recordPullRequest(started.started, { state: 'merged', settledAt: run.endTime, rework: 0 });
};

test('given a run detail page of a dispatched workload, when its attempts link is followed at phone width, then the attempts view lists the attempts without the page scrolling sideways', async ({
  dashboard,
  page,
}) => {
  attempt(dashboard.store, 'first', '2026-09-21T10:00:00.000Z', false);
  attempt(dashboard.store, 'second', '2026-09-22T10:00:00.000Z', true);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/runs/first');

  await page.getByRole('link', { name: 'All attempts' }).click();

  await expect(page).toHaveURL(/\/tickets\/forge\/42$/);
  await expect(page.locator('[data-attempt]')).toHaveCount(2);
  await expect(page.locator('[data-attempt="second"] [data-outcome]')).toHaveText('merged');
  expect(await page.locator('html').evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
});

test('given the attempts view at desktop width, when it is opened, then every column fits in the table without scrolling sideways', async ({
  dashboard,
  page,
}) => {
  attempt(dashboard.store, 'first', '2026-09-21T10:00:00.000Z', false);
  attempt(dashboard.store, 'second', '2026-09-22T10:00:00.000Z', true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/tickets/forge/42');

  const overflow = await page
    .locator('[data-attempts-table]')
    .evaluate((element) => element.scrollWidth - element.clientWidth);

  expect(overflow).toBe(0);
});

const revise = (store: Store, runId: string, start: string, state: 'done' | 'failed' | 'exceeded' | 'interrupted'): void => {
  store.insertRun({
    id: runId,
    worker: 'reviser',
    harness: 'pi',
    model: fingerprint.model,
    reasoningEffort: 'high',
    startTime: start,
    endTime: new Date(Date.parse(start) + 150_000).toISOString(),
    status: 'success',
    costStatus: 'billed',
    costUsd: 0.4,
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
    ticket: null,
    aliveAt: null,
    harnessStartTime: null,
    timeoutSeconds: null,
    maxCostUsd: null,
    exceededLimit: null,
    counters: null,
  });
  const started = store.startRevision(
    { repository: 'forge', number: 7, url: 'https://github.com/rameezk/forge/pull/7' },
    [ticket.number],
    runId,
    start,
    10,
  );
  if (!('started' in started)) throw new Error('revision refused');
  const stopped = state === 'exceeded' || state === 'interrupted';
  store.endRevision(
    started.started,
    stopped ? 'failed' : state,
    new Date(Date.parse(start) + 150_000).toISOString(),
    stopped ? { reason: state, detail: null } : undefined,
  );
};

for (const colorScheme of ['light', 'dark'] as const) {
  for (const [name, width] of [['desktop', 1280], ['phone', 375]] as const) {
    test(`given an attempt with several revisions, when the attempts view is shown at ${name} width in ${colorScheme}, then the revisions sit under their attempt and nothing overflows`, async ({
      dashboard,
      page,
    }) => {
      attempt(dashboard.store, 'first', '2026-09-21T10:00:00.000Z', false);
      attempt(dashboard.store, 'second', '2026-09-22T10:00:00.000Z', false);
      revise(dashboard.store, 'rev-1', '2026-09-23T10:00:00.000Z', 'done');
      revise(dashboard.store, 'rev-2', '2026-09-24T10:00:00.000Z', 'failed');
      revise(dashboard.store, 'rev-3', '2026-09-25T10:00:00.000Z', 'exceeded');
      revise(dashboard.store, 'rev-4', '2026-09-26T10:00:00.000Z', 'interrupted');
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/tickets/forge/42');

      await expect(page.locator('[data-revision]')).toHaveCount(4);
      await expect(page.locator('[data-revision="rev-2"] [data-outcome]')).toHaveText('failed');
      expect(await page.locator('html').evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
      const table = page.locator('[data-attempts-table]');
      if (width > 1000) {
        expect(await table.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
      }
    });
  }
}

const failRevisionStart = (store: Store, at: string): void => {
  const started = store.startRevision(
    { repository: 'forge', number: 7, url: 'https://github.com/rameezk/forge/pull/7' },
    [ticket.number],
    'never-started',
    at,
    10,
  );
  if (!('started' in started)) throw new Error('revision refused');
  store.failRevisionStart(started.started, 'clone failed', at);
};

const seedClickableRows = (store: Store): void => {
  attempt(store, 'first', '2026-09-21T10:00:00.000Z', false);
  revise(store, 'rev-1', '2026-09-23T10:00:00.000Z', 'done');
};

type Styled = { getComputedStyle: (element: unknown, pseudo: string) => { getPropertyValue: (name: string) => string } };

const offGithub = async (page: Page): Promise<void> => {
  await page.context().route('https://github.com/**', (route) => route.fulfill({ body: 'github' }));
};

const clickInside = async (page: Page, target: Locator, at: 'center' | 'start' = 'center'): Promise<void> => {
  const box = await target.boundingBox();
  if (box === null) throw new Error('target has no box');
  await (at === 'center' ? page.mouse.click(box.x + box.width / 2, box.y + box.height / 2) : page.mouse.click(box.x + 3, box.y + 3));
};

test.describe('clickable rows', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('given the Workloads table, when a cell holding no link is clicked, then that workload opens', async ({ dashboard, page }) => {
    seedClickableRows(dashboard.store);
    await page.goto('/workloads');

    await clickInside(page, page.locator('[data-run="first"] [data-cost]'));

    await expect(page).toHaveURL(/\/runs\/first$/);
  });

  test('given a Workloads row with ticket and pull request links, when either is clicked, then it goes to its own destination', async ({ dashboard, page }) => {
    seedClickableRows(dashboard.store);
    await offGithub(page);
    await page.goto('/workloads');

    const ticketLink = page.locator('[data-run="first"] [data-run-ticket] a').first();
    const ticketHref = await ticketLink.getAttribute('href');
    const [ticketPage] = await Promise.all([page.context().waitForEvent('page'), clickInside(page, ticketLink)]);
    await expect(ticketPage).toHaveURL(ticketHref!);

    const pullRequestLink = page.locator('[data-run="rev-1"] [data-run-ticket] a').first();
    const pullRequestHref = await pullRequestLink.getAttribute('href');
    const [pullRequestPage] = await Promise.all([page.context().waitForEvent('page'), clickInside(page, pullRequestLink)]);
    await expect(pullRequestPage).toHaveURL(pullRequestHref!);
    await expect(page).toHaveURL(/\/workloads$/);
  });

  test('given the Workloads table, when a row link takes keyboard focus, then the outline spans the stretched link over the whole row and the pointer shows across it', async ({ dashboard, page }) => {
    seedClickableRows(dashboard.store);
    await page.goto('/workloads');
    const row = page.locator('[data-run="first"]');
    const link = row.getByRole('link', { name: 'builder' });
    const afterStyle = (property: string) =>
      link.evaluate(
        (element, name) => (globalThis as unknown as Styled).getComputedStyle(element, '::after').getPropertyValue(name),
        property,
      );
    await expect(row).toHaveCSS('cursor', 'pointer');
    expect(await afterStyle('outline-style')).toBe('none');

    await link.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');

    await expect(link).toBeFocused();
    expect(await afterStyle('outline-style')).toBe('solid');
    expect(await afterStyle('outline-width')).toBe('2px');
    expect(await afterStyle('position')).toBe('absolute');
    expect(await afterStyle('inset')).toBe('0px');
    await expect(link).toHaveCSS('outline-style', 'none');
  });

  test('given a ticket with an attempt and a revision that ran, when empty space in each row is clicked, then each opens its own workload', async ({ dashboard, page }) => {
    seedClickableRows(dashboard.store);
    await page.goto('/tickets/forge/42');

    await clickInside(page, page.locator('[data-attempt="first"] [data-field="cost"]'));
    await expect(page).toHaveURL(/\/runs\/first$/);

    await page.goBack();
    await clickInside(page, page.locator('[data-revision="rev-1"] [data-field="duration"]'));
    await expect(page).toHaveURL(/\/runs\/rev-1$/);
  });

  test('given an attempt row with cohort and pull request links, when either is clicked, then it goes to its own destination', async ({ dashboard, page }) => {
    seedClickableRows(dashboard.store);
    await offGithub(page);
    await page.goto('/tickets/forge/42');

    await clickInside(page, page.locator('[data-attempt="first"] [data-field="cohort"] a'), 'start');
    await expect(page).toHaveURL(/\/cohorts\//);

    await page.goBack();
    const [pullRequestPage] = await Promise.all([
      page.context().waitForEvent('page'),
      clickInside(page, page.locator('[data-attempt="first"] [data-field="pull-request"] a')),
    ]);
    await expect(pullRequestPage).toHaveURL('https://github.com/rameezk/forge/pull/7');
    await expect(page).toHaveURL(/\/tickets\/forge\/42$/);
  });

  test('given a revision that failed to start, when its row is hovered and clicked, then the pointer is not shown and the page stays', async ({ dashboard, page }) => {
    seedClickableRows(dashboard.store);
    failRevisionStart(dashboard.store, '2026-09-25T10:00:00.000Z');
    await page.goto('/tickets/forge/42');
    const row = page.locator('[data-failed-start]');
    const cell = row.locator('[data-field="duration"]');

    await cell.hover();
    await expect(row).not.toHaveCSS('cursor', 'pointer');
    await expect(cell).not.toHaveCSS('cursor', 'pointer');
    await clickInside(page, cell);

    await expect(page).toHaveURL(/\/tickets\/forge\/42$/);
    await expect(row.getByRole('link')).toHaveCount(0);
  });
});
