import type { Page } from '@playwright/test';
import type { HarnessEvent, RunRecord } from '@forge/shared';
import { expect, test } from './dashboard.ts';

const usage = { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

const finishedRun: RunRecord = {
  id: 'run-01',
  worker: 'refiner',
  harness: 'pi',
  model: 'anthropic/claude-opus-4',
  reasoningEffort: null,
  startTime: '2026-09-21T10:00:00.000Z',
  endTime: '2026-09-21T10:03:20.000Z',
  status: 'error',
  costStatus: 'billed',
  costUsd: 0.1234,
  costEstimated: false,
  listPrice: null,
  inputTokens: 4200,
  outputTokens: 850,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  transcriptRef: 'run-01.jsonl',
  sessionId: 'sess-abc',
  error: 'provider exploded',
  ticket: null,
  aliveAt: null,
  harnessStartTime: null,
  timeoutSeconds: null,
  maxCostUsd: null,
  exceededLimit: null,
  counters: { toolCalls: 30, failedToolResults: 1, retries: 0, compactions: 0 },
};

const runningRun: RunRecord = { ...finishedRun, endTime: null, status: 'running', costStatus: 'pending', costUsd: 0, error: null };

const say = (text: string): HarnessEvent => ({ type: 'message', role: 'assistant', text, usage, generationId: null }) as HarnessEvent;

const toolCall = (id: string, path: string): HarnessEvent => ({ type: 'tool_call', id, name: 'read', arguments: { path } });

const toolResult = (id: string, text: string, isError = false): HarnessEvent => ({ type: 'tool_result', id, isError, text });

const longTranscript = (): HarnessEvent[] => [
  ...Array.from({ length: 30 }, (_, index) => say(`step ${index + 1}`)),
  toolCall('bad', 'missing.txt'),
  toolResult('bad', 'no such file', true),
  ...Array.from({ length: 30 }, (_, index) => say(`later ${index + 1}`)),
];

const seed = (dashboard: { store: { insertRun: (run: RunRecord) => void }; appendEvents: (ref: string, ...events: HarnessEvent[]) => void }, events = longTranscript()): void => {
  dashboard.store.insertRun(finishedRun);
  dashboard.appendEvents('run-01.jsonl', ...events);
};

type Styled = { getComputedStyle(element: unknown): { overflowY: string } };

type Metrics = { document: { documentElement: { scrollHeight: number; clientHeight: number; scrollWidth: number; clientWidth: number } } };

const pageScrolls = (page: Page): Promise<{ vertical: boolean; sideways: boolean }> =>
  page.evaluate(() => {
    const { documentElement } = (globalThis as unknown as Metrics).document;
    return {
      vertical: documentElement.scrollHeight > documentElement.clientHeight,
      sideways: documentElement.scrollWidth > documentElement.clientWidth,
    };
  });

test('given a workload with a long transcript, when its run page is opened at laptop width, then the figures and the widget sit side by side, each scrolls on its own and the page does not scroll', async ({ dashboard, page }) => {
  seed(dashboard);
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.goto('/runs/run-01');

  const tiles = (await page.locator('[data-tiles]').boundingBox())!;
  const widget = (await page.locator('[data-widget]').boundingBox())!;
  expect(tiles.x + tiles.width).toBeLessThanOrEqual(widget.x);
  expect(await pageScrolls(page)).toEqual({ vertical: false, sideways: false });
  const rows = page.locator('[data-widget-rows]');
  expect(await rows.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  const overflowOf = (selector: string) => page.locator(selector).evaluate((element) => (globalThis as unknown as Styled).getComputedStyle(element).overflowY);
  expect(await overflowOf('[data-widget-rows]')).toBe('auto');
  expect(await overflowOf('[data-figures]')).toBe('auto');

  await page.setViewportSize({ width: 1280, height: 420 });
  const figures = page.locator('[data-figures]');
  expect(await figures.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(await pageScrolls(page)).toEqual({ vertical: false, sideways: false });
});

test('given a finished workload, when its run page is opened at laptop width and at phone width, then Run details is open on the laptop and collapsed on the phone', async ({ dashboard, page }) => {
  seed(dashboard);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/runs/run-01');
  await expect(page.locator('[data-run-details]')).toHaveAttribute('open', '');

  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/runs/run-01');

  await expect(page.locator('[data-run-details]')).not.toHaveAttribute('open', '');
});

test('given a workload with a transcript, when its run page is opened at tablet width, then the columns stack and the widget sits below the details at a fixed height', async ({ dashboard, page }) => {
  seed(dashboard);
  await page.setViewportSize({ width: 800, height: 700 });

  await page.goto('/runs/run-01');

  const details = (await page.locator('[data-run-details]').boundingBox())!;
  const widget = (await page.locator('[data-widget]').boundingBox())!;
  expect(widget.y).toBeGreaterThanOrEqual(details.y + details.height);
  expect(widget.height).toBe(384);
  expect(await pageScrolls(page)).toEqual({ vertical: true, sideways: false });
});

test('given a workload with a transcript, when its run page is opened at phone width, then the widget is a card of the last 5 events with an Open full transcript link', async ({ dashboard, page }) => {
  seed(dashboard);
  await page.setViewportSize({ width: 390, height: 800 });

  await page.goto('/runs/run-01');

  await expect(page.locator('[data-widget-row]:visible')).toHaveCount(5);
  await expect(page.locator('[data-widget-open]')).toBeVisible();
  await expect(page.locator('[data-widget-expand]')).toBeHidden();
  expect((await pageScrolls(page)).sideways).toBe(false);
});

test('given a workload with a failed tool call, when the widget links are followed, then they land on the full transcript unfiltered, filtered to errors and at that event', async ({ dashboard, page }) => {
  seed(dashboard);
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.goto('/runs/run-01');
  await page.locator('[data-widget-expand]').click();
  await expect(page).toHaveURL(/\/runs\/run-01\/transcript$/);

  await page.goto('/runs/run-01');
  await page.locator('[data-widget-first-error]').click();
  await expect(page).toHaveURL(/\/runs\/run-01\/transcript\?show=errors$/);

  await page.goto('/runs/run-01');
  await page.locator('[data-widget-row]').filter({ has: page.locator('[data-badge="error"]') }).click();
  await expect(page).toHaveURL(/\/runs\/run-01\/transcript#event-30$/);
  await expect(page.locator('#event-30')).toBeInViewport();
});

test('given a running workload whose run page is open, when new events are recorded, then they appear at the top of the widget without a reload', async ({ dashboard, page }) => {
  dashboard.store.insertRun(runningRun);
  dashboard.appendEvents('run-01.jsonl', say('first'));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/runs/run-01');
  await expect(page.getByRole('status')).toHaveText('Live');

  dashboard.appendEvents('run-01.jsonl', say('second'));

  await expect(page.locator('[data-widget-row]').first()).toContainText('second');
  await expect(page.locator('[data-widget-row]')).toHaveCount(2);
});

test('given a workload with a transcript, when its run page is opened at laptop width and at phone width, then the transcript starts level with the first stat box under a header spanning both columns, and on the phone everything stacks without sideways scroll', async ({ dashboard, page }) => {
  seed(dashboard);
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.goto('/runs/run-01');

  const head = (await page.locator('[data-run-head]').boundingBox())!;
  const tile = (await page.locator('[data-tile="cost"]').boundingBox())!;
  const widget = (await page.locator('[data-widget]').boundingBox())!;
  expect(widget.y).toBe(tile.y);
  expect(head.y + head.height).toBeLessThanOrEqual(tile.y);
  expect(head.x + head.width).toBeGreaterThanOrEqual(widget.x + widget.width);

  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/runs/run-01');

  const phoneHead = (await page.locator('[data-run-head]').boundingBox())!;
  const phoneTile = (await page.locator('[data-tile="cost"]').boundingBox())!;
  const phoneWidget = (await page.locator('[data-widget]').boundingBox())!;
  expect(phoneHead.y + phoneHead.height).toBeLessThanOrEqual(phoneTile.y);
  expect(phoneTile.y).toBeLessThan(phoneWidget.y);
  expect((await pageScrolls(page)).sideways).toBe(false);
});
