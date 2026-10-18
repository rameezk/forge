import type { RunRecord } from '@forge/shared';
import { expect, test } from './dashboard.ts';

const recordedRun: RunRecord = {
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

test('given a dashboard serving a real store with one recorded run, when the runs list is opened, then the run is visible', async ({
  dashboard,
  page,
}) => {
  dashboard.store.insertRun(recordedRun);

  await page.goto('/workloads');

  const row = page.getByRole('row', { name: /refiner/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText('anthropic/claude-opus-4');
  await expect(row).toContainText('$0.1234');
  await expect(row.getByRole('link', { name: 'refiner' })).toHaveAttribute('href', '/runs/run-01');
});

test('given a running workload with an estimated cost and a finished one whose cost is both estimated and unconfirmed, when the runs list is opened on a desktop screen, then every cost badge shows without the table scrolling sideways', async ({
  dashboard,
  page,
}) => {
  dashboard.store.insertRun({ ...recordedRun, id: 'running', status: 'running', endTime: null, costStatus: 'pending', costUsd: 1.234567, costEstimated: true });
  dashboard.store.insertRun({ ...recordedRun, id: 'given-up', model: 'anthropic/claude-opus-5.5', costStatus: 'unconfirmed', costUsd: 0.5, costEstimated: true, ticket: { repository: 'forge', number: 158, url: 'https://github.com/rameezk/forge/issues/158' } });

  await page.goto('/workloads');

  await expect(page.locator('table [data-badge="estimated"]')).toHaveCount(2);
  await expect(page.locator('table [data-badge="unconfirmed"]')).toBeVisible();
  const card = page.locator('table').locator('..');
  expect(await card.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
});

test.describe('with JS disabled', () => {
  test.use({ javaScriptEnabled: false });

  test('given the same dashboard, when the runs list is opened, then it renders fully', async ({ dashboard, page }) => {
    dashboard.store.insertRun(recordedRun);

    await page.goto('/workloads');

    await expect(page.getByRole('heading', { name: 'Workloads' })).toBeVisible();
    await expect(page.getByRole('row', { name: /refiner/ })).toBeVisible();
    await expect(page.getByText(/Showing 1 of 1 workloads/)).toContainText('$0.1234');
  });
});

test('given a workload whose calls are billed, estimated and flagged as cache misses with long served model names, when its detail page is opened on a desktop screen, then every cost badge shows and the page does not scroll sideways', async ({
  dashboard,
  page,
}) => {
  dashboard.store.insertRun({ ...recordedRun, transcriptRef: null, reasoningEffort: 'high', model: 'anthropic/claude-opus-5.5' });
  const usage = (cacheReadTokens: number, cacheWriteTokens: number) => ({ inputTokens: 120, outputTokens: 450, cacheReadTokens, cacheWriteTokens });
  [usage(0, 20000), usage(20000, 800), usage(0, 20800)].forEach((tokens, index) =>
    dashboard.store.recordGeneration({ runId: 'run-01', generationId: `gen-0${index}`, subagent: null, kind: 'message', usage: tokens, estimatedCostUsd: 0.14, createdAt: `2026-09-21T10:0${index}:10.000Z` }),
  );
  const [first] = dashboard.store.unsettledGenerations();
  dashboard.store.recordLookups(
    [{ id: first!.id, billing: { costUsd: 0.1021, usage: null, reasoningTokens: 812, provider: 'Google Vertex', model: 'anthropic/claude-opus-5.5-20260921' } }],
    '2026-09-21T10:30:00.000Z',
  );

  await page.goto('/runs/run-01');
  await page.locator('[data-calls-summary]').click();

  await expect(page.locator('[data-calls] [data-badge="billed"]')).toHaveCount(1);
  await expect(page.locator('[data-calls] [data-badge="estimated"]')).toHaveCount(2);
  await expect(page.locator('[data-calls] [data-badge="cache-miss"]')).toHaveCount(1);
  expect(await page.locator('html').evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
});

test('given a workload with message, compaction and cache-warm generations, when its detail page is opened, then compaction and cache-warm rows carry a kind badge, message rows carry none, and the page does not scroll sideways', async ({
  dashboard,
  page,
}) => {
  dashboard.store.insertRun({ ...recordedRun, transcriptRef: null, model: 'anthropic/claude-opus-5.5' });
  const usage = { inputTokens: 120, outputTokens: 450, cacheReadTokens: 20000, cacheWriteTokens: 800 };
  (['message', 'compaction', 'message', 'cache_warm'] as const).forEach((kind, index) =>
    dashboard.store.recordGeneration({ runId: 'run-01', generationId: `gen-0${index}`, subagent: null, kind, usage, estimatedCostUsd: 0.14, createdAt: `2026-09-21T10:0${index}:10.000Z` }),
  );

  await page.goto('/runs/run-01');
  await page.locator('[data-calls-summary]').click();

  const rows = page.locator('[data-calls] [data-call]');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0).locator('[data-badge]')).toHaveCount(1);
  await expect(rows.nth(1).locator('[data-badge="compaction"]')).toHaveText('compaction');
  await expect(rows.nth(2).locator('[data-badge]')).toHaveCount(1);
  await expect(rows.nth(3).locator('[data-badge="cache-warm"]')).toHaveText('cache warm');
  expect(await page.locator('html').evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
});

test('given a run whose agent loaded skills from its prompt, in the parent and in review subagents, when its page is opened on a phone screen, then the Skills section lists each skill with where it loaded, badges the partial one and the page does not scroll sideways', async ({
  dashboard,
  page,
}) => {
  dashboard.store.insertRun(recordedRun);
  dashboard.appendEvents('run-01.jsonl', { type: 'message', role: 'user', text: 'work', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, generationId: null });
  const load = (skill: string, source: 'prompt' | 'read', subagent: string | null, coveredLines = 142) =>
    dashboard.store.recordSkillLoad({ runId: 'run-01', skill, source, subagent, loadedAt: '2026-09-21T10:00:01.000Z', coverage: { coveredLines, totalLines: 142 } });
  load('work-on', 'prompt', null);
  load('code-review', 'read', 'call_1', 60);
  load('security-review', 'read', 'call_2');
  load('security-review', 'read', 'call_3');
  await page.setViewportSize({ width: 390, height: 800 });

  await page.goto('/runs/run-01');

  const skills = page.locator('[data-skills] [data-skill]');
  await expect(skills).toHaveText([/code-review\s*1 subagent\s*partial · 60\/142/, /security-review\s*2 subagents/, /work-on\s*prompt/]);
  expect(await page.locator('html').evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
});

test('given a run with a subagent that loaded two skills and one that loaded none, when its page is opened on a phone screen, then the first header carries both chips, the second shows unclassified, and nothing scrolls sideways', async ({
  dashboard,
  page,
}) => {
  dashboard.store.insertRun(recordedRun);
  const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
  dashboard.appendEvents(
    'run-01.jsonl',
    { type: 'tool_call', id: 'call_1', name: 'subagent', arguments: { task: 'Review the change for standards and for security' } },
    { type: 'tool_call', id: 'call_2', name: 'subagent', arguments: { task: 'Summarise the change' } },
    { type: 'message', role: 'assistant', text: 'reviewing', usage, generationId: null, subagent: 'call_1' },
    { type: 'message', role: 'assistant', text: 'summarising', usage, generationId: null, subagent: 'call_2' },
    { type: 'tool_result', id: 'call_1', isError: false, text: 'No findings.' },
    { type: 'tool_result', id: 'call_2', isError: false, text: 'A summary.' },
  );
  const load = (skill: string, subagent: string) =>
    dashboard.store.recordSkillLoad({ runId: 'run-01', skill, source: 'read', subagent, loadedAt: '2026-09-21T10:00:01.000Z', coverage: null });
  load('security-review', 'call_1');
  load('code-review', 'call_1');
  await page.setViewportSize({ width: 390, height: 800 });

  await page.goto('/runs/run-01/transcript');

  const headers = page.locator('[data-subagent-call] summary');
  await expect(headers.nth(0).locator('[data-subagent-kind]')).toHaveText(['code-review', 'security-review']);
  await expect(headers.nth(1).locator('[data-subagent-kind]')).toHaveText(['unclassified']);
  expect(await page.locator('html').evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
});

test('given a claude-code run whose two Agent subagents loaded a skill and none, when its page is opened on a phone screen, then each header is titled by its prompt with its skill chips, and nothing scrolls sideways', async ({
  dashboard,
  page,
}) => {
  dashboard.store.insertRun({ ...recordedRun, harness: 'claude-code', model: 'claude-opus-4-5', costStatus: 'subscription', costUsd: 0 });
  const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const agent = (id: string, prompt: string) => ({
    type: 'tool_call' as const,
    id,
    name: 'Agent',
    arguments: { description: 'Subagent', subagent_type: 'general-purpose', prompt },
  });
  dashboard.appendEvents(
    'run-01.jsonl',
    agent('toolu_alpha', 'Review the change for standards'),
    agent('toolu_beta', 'Summarise the change'),
    { type: 'message', role: 'assistant', text: 'reviewing', usage, generationId: null, subagent: 'toolu_alpha' },
    { type: 'tool_call', id: 'toolu_skill', name: 'Skill', arguments: { skill: 'code-review' }, subagent: 'toolu_alpha' },
    { type: 'tool_result', id: 'toolu_skill', isError: false, text: 'Launching skill: code-review', subagent: 'toolu_alpha' },
    { type: 'message', role: 'assistant', text: 'summarising', usage, generationId: null, subagent: 'toolu_beta' },
    { type: 'tool_result', id: 'toolu_alpha', isError: false, text: 'No findings.' },
    { type: 'tool_result', id: 'toolu_beta', isError: false, text: 'A summary.' },
  );
  dashboard.store.recordSkillLoad({ runId: 'run-01', skill: 'code-review', source: 'read', subagent: 'toolu_alpha', loadedAt: '2026-09-21T10:00:01.000Z', coverage: { coveredLines: 142, totalLines: 142 } });
  await page.setViewportSize({ width: 390, height: 800 });

  await page.goto('/runs/run-01/transcript');

  const headers = page.locator('[data-subagent-call] > details > summary');
  await expect(headers.nth(0).locator('[data-subagent-task]')).toHaveText('Review the change for standards');
  await expect(headers.nth(0).locator('[data-subagent-kind]')).toHaveText(['code-review']);
  await expect(headers.nth(1).locator('[data-subagent-task]')).toHaveText('Summarise the change');
  await expect(headers.nth(1).locator('[data-subagent-kind]')).toHaveText(['unclassified']);
  expect(await page.locator('html').evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);

  await page.goto('/runs/run-01');

  await expect(page.locator('[data-skills] [data-skill]')).toHaveText([/code-review\s*1 subagent/]);
});

test('given a subagent with a long narration, when its page is opened on a phone screen, then its header keeps the task and the truncated narration on one line each', async ({
  dashboard,
  page,
}) => {
  dashboard.store.insertRun(recordedRun);
  const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const narration = 'Reading every file under the runtime packages to map how the transcript view groups a subagent and where its header is drawn. '.repeat(3);
  dashboard.appendEvents(
    'run-01.jsonl',
    { type: 'tool_call', id: 'call_alpha', name: 'subagent', arguments: { task: 'Review the change for standards' } },
    { type: 'message', role: 'assistant', text: narration, usage, generationId: null, subagent: 'call_alpha' },
    { type: 'message', role: 'assistant', text: 'Final report.', usage, generationId: null, subagent: 'call_alpha' },
    { type: 'tool_result', id: 'call_alpha', isError: false, text: 'Final report.' },
  );
  await page.setViewportSize({ width: 390, height: 800 });

  await page.goto('/runs/run-01/transcript');

  const header = page.locator('[data-subagent-call] > details > summary');
  const line = header.locator('[data-subagent-narration]');
  await expect(line).toContainText('Reading every file');
  expect(await line.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect((await line.boundingBox())?.height ?? 0).toBeLessThan(20);
  expect(await page.locator('html').evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
});

test('given a claude-code run on subscription, when its page is opened, then the summary shows the claude-code harness and the anthropic provider', async ({
  dashboard,
  page,
}) => {
  dashboard.store.insertRun({
    ...recordedRun,
    harness: 'claude-code',
    model: 'claude-opus-4-5',
    costStatus: 'subscription',
    costUsd: 0,
  });

  await page.goto('/runs/run-01');

  await expect(page.locator('[data-harness]')).toHaveText('claude-code');
  await expect(page.getByText('anthropic', { exact: true })).toBeVisible();
});

const seedWorkloads = (dashboard: { store: { insertRun: (run: RunRecord) => void } }) => {
  dashboard.store.insertRun({ ...recordedRun, id: 'run-a', startTime: '2026-09-21T10:00:00.000Z', reasoningEffort: 'high', cacheReadTokens: 9000, ticket: { repository: 'forge', number: 377, url: 'https://github.com/rameezk/forge/issues/377' } });
  dashboard.store.insertRun({ ...recordedRun, id: 'run-b', worker: 'reviewer', status: 'error', startTime: '2026-09-22T10:00:00.000Z', model: 'anthropic/claude-sonnet-5.5', costUsd: 0.5 });
};

test.describe('on a phone screen', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('given recorded workloads, when Workloads is opened, then each is a card with its fields linking to the run and no table is shown', async ({ dashboard, page }) => {
    seedWorkloads(dashboard);

    await page.goto('/workloads');

    await expect(page.locator('table')).toBeHidden();
    const cards = page.locator('[data-run-card]');
    await expect(cards).toHaveCount(2);
    const card = page.locator('[data-run-card="run-a"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText('2026-09-21');
    await expect(card.locator('[data-status="success"]')).toBeVisible();
    await expect(card).toContainText('#377');
    await expect(card).toContainText('refiner');
    await expect(card).toContainText('anthropic/claude-opus-4');
    await expect(card.locator('[data-effort]')).toHaveText('high');
    await expect(card.locator('[data-duration]')).toHaveText('3m 20s');
    await expect(card.locator('[data-cache-hit]')).toContainText('68.2%');
    await expect(card.locator('[data-cost]')).toContainText('$0.1234');
    await expect(card.getByRole('link', { name: /refiner/ }).first()).toHaveAttribute('href', '/runs/run-a');
    const box = await card.boundingBox();
    const link = await card.locator('a[data-card-link]').boundingBox();
    expect(link).toEqual(box);
  });

  test('given status chips wider than the screen, when Workloads is opened, then the chips scroll sideways in one row and the page does not', async ({ dashboard, page }) => {
    seedWorkloads(dashboard);

    await page.goto('/workloads');

    const chips = page.locator('[data-status-chips]');
    expect(await chips.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    const tops = await page.locator('[data-status-chip]').evaluateAll((elements) => elements.map((element) => Math.round(element.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(1);
    expect(await page.locator('html').evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
  });

  test('given recorded workloads, when Workloads is opened, then each status chip lies fully within the visible area of the chip row', async ({ dashboard, page }) => {
    seedWorkloads(dashboard);

    await page.goto('/workloads');

    const row = await page.locator('[data-status-chips]').evaluate((element) => {
      const { top } = element.getBoundingClientRect();
      return { top: top + element.clientTop, bottom: top + element.clientTop + element.clientHeight };
    });
    const chips = await page.locator('[data-status-chip]').evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect()).map(({ top, bottom }) => ({ top, bottom })));
    expect(chips).toHaveLength(6);
    for (const chip of chips) {
      expect(chip.top).toBeGreaterThanOrEqual(row.top);
      expect(chip.bottom).toBeLessThanOrEqual(row.bottom);
    }
  });

  test('given a started range in the address, when Workloads is opened, then the other filters are behind a collapsed Filters toggle showing the range, and opening it reveals them', async ({ dashboard, page }) => {
    seedWorkloads(dashboard);

    await page.goto('/workloads?from=2026-09-20&to=2026-09-30');

    const toggle = page.locator('details[data-filters]');
    await expect(toggle.locator('summary')).toContainText('Filters');
    await expect(toggle.locator('summary')).toContainText('2026-09-20 to 2026-09-30');
    await expect(page.getByPlaceholder('Worker or ticket number')).toBeHidden();
    await expect(page.getByLabel('Model')).toBeHidden();
    await toggle.locator('summary').click();
    await expect(page.getByPlaceholder('Worker or ticket number')).toBeVisible();
    await expect(page.getByLabel('Worker')).toBeVisible();
    await expect(page.getByLabel('Repository')).toBeVisible();
    await expect(page.getByLabel('Model')).toBeVisible();
  });
});

test.describe('on a laptop screen', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('given recorded workloads, when Workloads is opened, then they are in the table and not cards, with the filters open', async ({ dashboard, page }) => {
    seedWorkloads(dashboard);

    await page.goto('/workloads');

    await expect(page.locator('table')).toBeVisible();
    await expect(page.locator('[data-run-card]').first()).toBeHidden();
    await expect(page.getByPlaceholder('Worker or ticket number')).toBeVisible();
    await expect(page.locator('[data-filters] summary')).toBeHidden();
  });
});

test('given a failed workload with a long error, when its page is opened and the error is clicked, then the error is cut off on one line until it is expanded to its full text', async ({
  dashboard,
  page,
}) => {
  const error = `build failed: ${'the compiler gave up after a very long chain of errors, '.repeat(12)}done`;
  dashboard.store.insertRun({ ...recordedRun, transcriptRef: null, status: 'error', error });

  await page.goto('/runs/run-01');

  const summary = page.locator('[data-run-error] summary');
  const lineHeight = await summary.evaluate((element) => parseFloat(element.ownerDocument.defaultView!.getComputedStyle(element).lineHeight));
  const paddedHeight = await summary.evaluate((element) => element.getBoundingClientRect().height);
  expect(await summary.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(paddedHeight).toBeLessThan(lineHeight * 2 + 20);

  await summary.click();

  expect(await summary.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(lineHeight * 2);
  await expect(summary).toHaveText(error);
});

test('given a finished workload, when its page is opened at laptop width, then Run details starts open and Calls starts collapsed and opens on click', async ({
  dashboard,
  page,
}) => {
  dashboard.store.insertRun({ ...recordedRun, transcriptRef: null });
  dashboard.store.recordGeneration({ runId: 'run-01', generationId: 'gen-01', subagent: null, kind: 'message', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, estimatedCostUsd: 0.01, createdAt: '2026-09-21T10:01:00.000Z' });

  await page.goto('/runs/run-01');

  await expect(page.locator('[data-harness]')).toBeVisible();
  await expect(page.locator('[data-calls]')).toBeHidden();
  await page.locator('[data-calls-summary]').click();
  await expect(page.locator('[data-calls]')).toBeVisible();
});
