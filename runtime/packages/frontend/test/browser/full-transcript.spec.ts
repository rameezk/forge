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
  status: 'success',
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
  error: null,
  ticket: null,
  aliveAt: null,
  harnessStartTime: null,
  timeoutSeconds: null,
  maxCostUsd: null,
  exceededLimit: null,
  counters: null,
};

const runningRun: RunRecord = { ...finishedRun, endTime: null, status: 'running', costStatus: 'pending', costUsd: 0 };

const say = (text: string, error?: string): HarnessEvent =>
  ({ type: 'message', role: 'assistant', text, usage, generationId: null, ...(error === undefined ? {} : { error }) }) as HarnessEvent;

const toolCall = (id: string, path: string): HarnessEvent => ({ type: 'tool_call', id, name: 'read', arguments: { path } });

const toolResult = (id: string, text: string, isError = false): HarnessEvent => ({ type: 'tool_result', id, isError, text });

const longText = Array.from({ length: 60 }, (_, line) => `line ${line + 1}`).join('\n');

type Scroller = { document: { documentElement: { scrollTop: number; scrollWidth: number; clientWidth: number } } };

const scrollTop = (page: Page): Promise<number> =>
  page.evaluate(() => (globalThis as unknown as Scroller).document.documentElement.scrollTop);

const scrollsSideways = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const { documentElement } = (globalThis as unknown as Scroller).document;
    return documentElement.scrollWidth > documentElement.clientWidth;
  });

const openLive = async (page: Page, path: string): Promise<void> => {
  await page.goto(path);
  await expect(page.getByRole('status')).toHaveText('Live');
};

test('given a run whose third tool call failed behind long failed messages, when the Errors filter is opened with that event\'s anchor, then the page scrolls to that event', async ({
  dashboard,
  page,
}) => {
  dashboard.store.insertRun(finishedRun);
  dashboard.appendEvents(
    'run-01.jsonl',
    toolCall('c1', 'a.txt'),
    toolResult('c1', 'a', true),
    say('first', longText),
    toolCall('c2', 'b.txt'),
    toolResult('c2', 'b', true),
    say('second', longText),
    toolCall('c3', 'c.txt'),
    toolResult('c3', 'c', true),
  );
  await page.goto('/runs/run-01/transcript?show=errors');
  const third = page.locator('[data-event-anchor]').filter({ has: page.locator('[data-failed]') }).nth(2);
  const anchor = await third.getAttribute('id');
  expect(anchor).toBeTruthy();

  await page.goto(`/runs/run-01/transcript?show=errors#${anchor}`);

  await expect(page.locator(`[id="${anchor}"]`)).toBeInViewport();
  expect(await scrollTop(page)).toBeGreaterThan(0);
});

test('given a running workload whose full transcript page is open with one tool call expanded, when new events are recorded, then they appear without a reload and the tool call stays expanded', async ({
  dashboard,
  page,
}) => {
  dashboard.store.insertRun(runningRun);
  dashboard.appendEvents('run-01.jsonl', toolCall('c1', 'docs/CONTEXT.md'), toolResult('c1', 'contents'), say('Reading.'));
  await openLive(page, '/runs/run-01/transcript');
  const call = page.locator('[data-tool-call]');
  await call.locator('summary').click();
  await expect(call).toHaveAttribute('open', '');

  dashboard.appendEvents('run-01.jsonl', say('Writing the failing test.'));

  await expect(page.getByText('Writing the failing test.')).toBeAttached();
  await expect(call).toHaveAttribute('open', '');
});

test('given a full transcript page at phone width, when it opens, then the filters are a row of chips that scrolls sideways and the page does not', async ({
  dashboard,
  page,
}) => {
  dashboard.store.insertRun(finishedRun);
  dashboard.appendEvents('run-01.jsonl', say('hello'), toolCall('c1', 'a.txt'), toolResult('c1', 'a'));
  await page.setViewportSize({ width: 390, height: 800 });

  await page.goto('/runs/run-01/transcript');

  const rail = page.locator('[data-filters]');
  const chips = rail.locator('[data-filter]');
  await expect(chips).toHaveCount(5);
  const tops = await chips.evaluateAll((links) => links.map((link) => Math.round(link.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  expect(await rail.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await scrollsSideways(page)).toBe(false);
});

test('given a full transcript page on a wide screen, when it opens, then the filters are a side rail beside the events', async ({
  dashboard,
  page,
}) => {
  dashboard.store.insertRun(finishedRun);
  dashboard.appendEvents('run-01.jsonl', say('hello'));
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.goto('/runs/run-01/transcript');

  const chips = page.locator('[data-filter]');
  const lefts = await chips.evaluateAll((links) => links.map((link) => Math.round(link.getBoundingClientRect().left)));
  expect(new Set(lefts).size).toBe(1);
  const rail = await page.locator('[data-filters]').boundingBox();
  const events = await page.locator('[data-transcript]').boundingBox();
  expect(rail!.x + rail!.width).toBeLessThanOrEqual(events!.x);
});
