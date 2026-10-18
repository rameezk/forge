import type { Page } from '@playwright/test';
import { fingerprintHash } from '@forge/shared';
import type { ConfigFingerprint, HarnessEvent, PolledFrontier, RunRecord, Store, Ticket } from '@forge/shared';
import { expect, test } from './dashboard.ts';

const runningRun: RunRecord = {
  id: 'run-01',
  worker: 'refiner',
  harness: 'pi',
  model: 'anthropic/claude-opus-4',
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
  counters: null,
};

const ticket: Ticket = {
  number: 137,
  title: 'Live runs list and Board',
  url: 'https://github.com/rameezk/forge/issues/137',
  parent: { number: 135, title: 'Live dashboard updates', url: 'https://github.com/rameezk/forge/issues/135' },
  createdAt: '2026-09-30T10:00:00Z',
  forgeReady: false,
  blocked: false,
  forHuman: false,
  blockedBy: [],
};

const polledFrontier: PolledFrontier = {
  repository: 'forge',
  github: 'rameezk/forge',
  polledAt: '2026-10-02T08:00:00.000Z',
  closed: [], requests: [],
  tickets: [ticket],
};

const openLive = async (page: Page, path: string): Promise<void> => {
  await page.goto(path);
  await expect(page.getByRole('status')).toHaveText('Live');
  await page.evaluate(() => {
    (globalThis as unknown as { unreloaded: boolean }).unreloaded = true;
  });
};

const wasReloaded = async (page: Page): Promise<boolean> =>
  (await page.evaluate(() => (globalThis as unknown as { unreloaded?: boolean }).unreloaded)) !== true;

const expectNotReloaded = async (page: Page): Promise<void> => {
  await expect(page.getByRole('status')).toHaveText('Live');
  expect(await wasReloaded(page)).toBe(false);
};

test('given the runs list open in a browser, when a run is recorded, changes status, and its cost settles, then the table shows each change without a reload', async ({
  dashboard,
  page,
}) => {
  await openLive(page, '/workloads');
  await expect(page.getByText('No workloads have run yet.')).toBeVisible();

  dashboard.store.insertRun(runningRun);
  const row = page.getByRole('row', { name: /refiner/ });
  await expect(row.locator('[data-status]')).toHaveText('running');

  dashboard.store.recordGeneration({
    runId: 'run-01',
    generationId: 'gen-01',
    subagent: null,
    kind: 'message',
    usage: { inputTokens: 4200, outputTokens: 850, cacheReadTokens: 0, cacheWriteTokens: 0 },
    estimatedCostUsd: null,
    createdAt: '2026-09-21T10:01:00.000Z',
  });
  dashboard.store.finalizeRun('run-01', {
    status: 'success',
    endTime: '2026-09-21T10:03:20.000Z',
    sessionId: 'sess-abc',
    error: null,
  });
  await expect(row.locator('[data-status]')).toHaveText('success');
  await expect(row.locator('[data-cost]')).toHaveText('pending');

  const [unsettled] = dashboard.store.unsettledGenerations();
  dashboard.store.recordLookups(
    [{ id: unsettled!.id, billing: { costUsd: 0.25, usage: null, reasoningTokens: null, provider: 'Anthropic', model: null } }],
    '2026-09-21T10:05:00.000Z',
  );
  await expect(row.locator('[data-cost]')).toHaveText('$0.250000');

  await expectNotReloaded(page);
});

test('given the runs list filtered to Error, when a run fails and another succeeds, then only the failed one joins the list and the counts follow without a reload', async ({
  dashboard,
  page,
}) => {
  dashboard.store.insertRun({ ...runningRun, id: 'earlier', worker: 'earlier-worker', status: 'success', endTime: '2026-09-21T10:03:20.000Z', costStatus: 'billed' });
  await openLive(page, '/workloads?status=error');
  await expect(page.getByText('No workloads match.')).toBeVisible();

  dashboard.store.insertRun({ ...runningRun, id: 'failed', worker: 'failing-worker', status: 'error', endTime: '2026-09-21T10:03:20.000Z', costStatus: 'billed' });

  await expect(page.getByRole('row', { name: /failing-worker/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /earlier-worker/ })).toHaveCount(0);
  await expect(page.locator('[data-status-chip="all"]')).toContainText('2');
  await expect(page.locator('[data-showing]')).toContainText('Showing 1 of 2 workloads');
  await expectNotReloaded(page);
});

test('given a live page whose data has not changed since it was rendered, when it loads and opens its change stream, then it does not refetch itself', async ({ dashboard, page }) => {
  dashboard.store.insertRun(runningRun);
  const refetched: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'fetch') refetched.push(request.url());
  });

  await openLive(page, '/workloads');
  await page.waitForTimeout(500);

  expect(refetched).toEqual([]);
});

test('given the runs list loaded before its stream connects, when a run is recorded in between, then the table shows it once the stream connects', async ({
  dashboard,
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/events?*', async (route) => {
    await held;
    await route.continue();
  });
  await page.goto('/workloads');
  await expect(page.getByText('No workloads have run yet.')).toBeVisible();

  dashboard.store.insertRun(runningRun);
  release();

  await expect(page.getByRole('row', { name: /refiner/ })).toBeVisible();
});

test('given the runs list open in a browser, when the dashboard starts serving different assets, then the page reloads to pick them up', async ({
  dashboard,
  page,
}) => {
  await openLive(page, '/workloads');
  await page.route(
    '/workloads',
    async (route) => {
      if (route.request().resourceType() !== 'fetch') return route.fallback();
      const response = await route.fetch();
      const body = (await response.text()).replace(/\/assets\/dashboard-[0-9a-f]+\.css/, '/assets/dashboard-0000000000000000.css');
      await route.fulfill({ response, body });
    },
    { times: 1 },
  );

  const reloaded = page.waitForEvent('load');
  dashboard.store.insertRun(runningRun);
  await reloaded;

  expect(await wasReloaded(page)).toBe(true);
  await expect(page.getByRole('row', { name: /refiner/ })).toBeVisible();
});

test('given the runs list whose refresh after a change failed, when its stream drops and reconnects, then the table catches up', async ({
  dashboard,
  page,
}) => {
  await openLive(page, '/workloads');
  const failed = page.waitForEvent('requestfailed');
  await page.route('/workloads', (route) => (route.request().resourceType() === 'fetch' ? route.abort() : route.fallback()), { times: 1 });

  dashboard.store.insertRun(runningRun);
  await failed;
  await expect(page.getByText('No workloads have run yet.')).toBeVisible();
  dashboard.dropConnections();

  await expect(page.getByRole('row', { name: /refiner/ })).toBeVisible({ timeout: 10_000 });
});

test('given the runs list open in a browser with an extension that added its own stylesheet to the page, when a run is recorded, then the table shows it without a reload', async ({
  dashboard,
  page,
}) => {
  await openLive(page, '/workloads');
  await page.evaluate(() => {
    const doc = (globalThis as unknown as { document: { head: { append(node: unknown): void }; createElement(tag: string): { rel: string; href: string } } }).document;
    const injected = doc.createElement('link');
    injected.rel = 'stylesheet';
    injected.href = 'data:text/css,';
    doc.head.append(injected);
  });

  dashboard.store.insertRun(runningRun);

  await expect(page.getByRole('row', { name: /refiner/ })).toBeVisible();
  await expectNotReloaded(page);
});

test('given the Board open in a browser, when a frontier poll writes new tickets, then the page shows them without a reload', async ({
  dashboard,
  page,
}) => {
  await openLive(page, '/');

  dashboard.store.replaceFrontier(polledFrontier);

  await expect(page.locator('article', { hasText: 'Live runs list and Board' })).toBeVisible();
  await expectNotReloaded(page);
});

test('given the runs list open in a browser, when the stream is connected, then dropped, then the indicator shows Live, then Reconnecting…', async ({
  dashboard,
  page,
}) => {
  await page.goto('/workloads');
  const indicator = page.getByRole('status');
  await expect(indicator).toHaveText('Live');

  await dashboard.stop();

  await expect(indicator).toHaveText('Reconnecting…');
});

test('given the runs list open in a browser, when its stream drops and the reconnect is refused, then the browser stops retrying and the indicator is gone', async ({
  dashboard,
  page,
}) => {
  await page.goto('/workloads');
  await expect(page.getByRole('status')).toHaveText('Live');
  await page.route('**/events?*', (route) => route.fulfill({ status: 502 }));

  await dashboard.stop();

  await expect(page.getByRole('status')).toHaveCount(0);
});

const NO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

const say = (text: string): HarnessEvent => ({ type: 'message', role: 'assistant', text, usage: NO_USAGE, generationId: null });

const toolCall = (id: string, path: string): HarnessEvent => ({ type: 'tool_call', id, name: 'read', arguments: { path } });

const toolResult = (id: string, text: string, isError = false): HarnessEvent => ({ type: 'tool_result', id, isError, text });

const longText = Array.from({ length: 80 }, (_, line) => `line ${line + 1}`).join('\n\n');

type Viewport = {
  scrollTo(x: number, y: number): void;
  scrollY: number;
  innerHeight: number;
  document: { documentElement: { scrollHeight: number } };
};

const scrollTo = (page: Page, top: number): Promise<void> =>
  page.evaluate((y) => (globalThis as unknown as Viewport).scrollTo(0, y), top);

const scrollTop = (page: Page): Promise<number> => page.evaluate(() => (globalThis as unknown as Viewport).scrollY);

const distanceFromBottom = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const viewport = globalThis as unknown as Viewport;
    return viewport.document.documentElement.scrollHeight - viewport.scrollY - viewport.innerHeight;
  });

const transcribedRun: RunRecord = { ...runningRun, transcriptRef: 'run-01.jsonl' };

test('given a detail page with a tool call the operator expanded, when a new transcript event arrives, then that tool call is still expanded and the scroll position is unchanged', async ({
  dashboard,
  page,
}) => {
  dashboard.store.insertRun(transcribedRun);
  dashboard.appendEvents(
    'run-01.jsonl',
    { type: 'message', role: 'user', text: 'Work on #138.', usage: NO_USAGE, generationId: null },
    toolCall('call-1', 'docs/CONTEXT.md'),
    toolResult('call-1', longText),
    say(longText),
  );
  await openLive(page, '/runs/run-01/transcript');
  const call = page.locator('[data-tool-call]');
  await call.locator('summary').click();
  await expect(call).toHaveAttribute('open', '');
  await scrollTo(page, 300);

  dashboard.appendEvents('run-01.jsonl', say('Writing the failing test.'));

  await expect(page.getByText('Writing the failing test.')).toBeAttached();
  await expect(call).toHaveAttribute('open', '');
  expect(await scrollTop(page)).toBe(300);
  await expectNotReloaded(page);
});

test('given a detail page with a tool call the operator expanded without clicking its summary, as find-in-page does, when a new transcript event arrives, then that tool call is still expanded', async ({
  dashboard,
  page,
}) => {
  dashboard.store.insertRun(transcribedRun);
  dashboard.appendEvents('run-01.jsonl', toolCall('call-1', 'docs/CONTEXT.md'), toolResult('call-1', 'ok'));
  await openLive(page, '/runs/run-01/transcript');
  const call = page.locator('[data-tool-call]');
  await call.evaluate((details) => {
    (details as unknown as { open: boolean }).open = true;
  });
  await expect(call).toHaveAttribute('open', '');

  dashboard.appendEvents('run-01.jsonl', say('Writing the failing test.'));

  await expect(page.getByText('Writing the failing test.')).toBeAttached();
  await expect(call).toHaveAttribute('open', '');
});

test('given a detail page with a tool call awaiting its result that the operator has not toggled, when its result arrives as an error, then the tool call is marked failed and stays collapsed', async ({
  dashboard,
  page,
}) => {
  dashboard.store.insertRun(transcribedRun);
  dashboard.appendEvents('run-01.jsonl', toolCall('call-1', 'docs/CONTEXT.md'));
  await openLive(page, '/runs/run-01/transcript');
  const call = page.locator('[data-tool-call]');
  await expect(call).not.toHaveAttribute('open');

  dashboard.appendEvents('run-01.jsonl', toolResult('call-1', 'ENOENT: no such file', true));

  await expect(call).toHaveAttribute('data-failed', '');
  await expect(call).not.toHaveAttribute('open');
  await expect(call.getByText('ENOENT: no such file')).toBeHidden();
});

test('given a running workload\'s detail page scrolled to the bottom, when new transcript events arrive, then the page stays scrolled to the bottom', async ({
  dashboard,
  page,
}) => {
  dashboard.store.insertRun(transcribedRun);
  dashboard.appendEvents('run-01.jsonl', say(longText));
  await openLive(page, '/runs/run-01/transcript');
  await scrollTo(page, 1e6);
  expect(await distanceFromBottom(page)).toBe(0);

  dashboard.appendEvents('run-01.jsonl', say(longText), say('Writing the failing test.'));

  await expect(page.getByText('Writing the failing test.')).toBeAttached();
  await expect.poll(() => distanceFromBottom(page)).toBe(0);
});

test('given a running workload\'s detail page scrolled up, when new transcript events arrive, then the view stays put and New activity appears, and activating it scrolls to the bottom', async ({
  dashboard,
  page,
}) => {
  dashboard.store.insertRun(transcribedRun);
  dashboard.appendEvents('run-01.jsonl', say(longText));
  await openLive(page, '/runs/run-01/transcript');
  await scrollTo(page, 300);
  const newActivity = page.getByRole('button', { name: '↓ New activity' });
  await expect(newActivity).toBeHidden();

  dashboard.appendEvents('run-01.jsonl', say(longText), say('Writing the failing test.'));

  await expect(newActivity).toBeVisible();
  expect(await scrollTop(page)).toBe(300);

  await newActivity.click();

  await expect.poll(() => distanceFromBottom(page)).toBe(0);
  await expect(newActivity).toBeHidden();
});

test('given a running workload\'s transcript page scrolled up with a tool call expanded, when its result arrives and the page grows without a new transcript event, then New activity stays hidden', async ({
  dashboard,
  page,
}) => {
  dashboard.store.insertRun(transcribedRun);
  dashboard.appendEvents('run-01.jsonl', say(longText), toolCall('call-1', 'docs/CONTEXT.md'));
  await openLive(page, '/runs/run-01/transcript');
  await page.locator('[data-tool-call] summary').click();
  await scrollTo(page, 300);

  dashboard.appendEvents('run-01.jsonl', toolResult('call-1', `RESULT-ARRIVED\n${longText}`));

  await expect(page.getByText('RESULT-ARRIVED')).toBeVisible();
  await expect(page.getByRole('button', { name: '↓ New activity' })).toBeHidden();
});

test('given a live detail page showing Live, when the workload\'s cost settles and done arrives, then the indicator disappears and the page stops updating', async ({
  dashboard,
  page,
}) => {
  dashboard.store.insertRun(transcribedRun);
  dashboard.appendEvents('run-01.jsonl', say('Reading the ticket.'));
  dashboard.store.recordGeneration({
    runId: 'run-01',
    generationId: 'gen-01',
    subagent: null,
    kind: 'message',
    usage: { inputTokens: 4200, outputTokens: 850, cacheReadTokens: 0, cacheWriteTokens: 0 },
    estimatedCostUsd: null,
    createdAt: '2026-09-21T10:01:00.000Z',
  });
  dashboard.store.finalizeRun('run-01', { status: 'success', endTime: '2026-09-21T10:03:20.000Z', sessionId: 'sess-abc', error: null });
  await openLive(page, '/runs/run-01');

  const [unsettled] = dashboard.store.unsettledGenerations();
  dashboard.store.recordLookups(
    [{ id: unsettled!.id, billing: { costUsd: 0.25, usage: null, reasoningTokens: null, provider: 'Anthropic', model: null } }],
    '2026-09-21T10:05:00.000Z',
  );

  await expect(page.locator('[data-tile="cost"]').getByText('$0.250000', { exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toHaveCount(0);
  dashboard.appendEvents('run-01.jsonl', say('Written after the run settled.'));
  await page.waitForTimeout(4_000);
  await expect(page.getByText('Written after the run settled.')).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveCount(0);
  expect(await wasReloaded(page)).toBe(false);
});

test.describe('with JS disabled', () => {
  test.use({ javaScriptEnabled: false });

  test('given a browser with JS disabled, when the runs list, the Board or a running workload\'s detail page is loaded, then it renders fully with no live indicator', async ({
    dashboard,
    page,
  }) => {
    dashboard.store.insertRun(transcribedRun);
    dashboard.appendEvents('run-01.jsonl', say('Reading the ticket.'));
    dashboard.store.replaceFrontier(polledFrontier);

    await page.goto('/workloads');
    await expect(page.getByRole('row', { name: /refiner/ })).toBeVisible();
    await expect(page.getByRole('status')).toHaveCount(0);
    await expect(page.getByText('Live', { exact: true })).toHaveCount(0);

    await page.goto('/');
    await expect(page.locator('article', { hasText: 'Live runs list and Board' })).toBeVisible();
    await expect(page.getByRole('status')).toHaveCount(0);
    await expect(page.getByText('Live', { exact: true })).toHaveCount(0);

    await page.goto('/runs/run-01');
    await expect(page.getByText('Reading the ticket.')).toBeVisible();
    await expect(page.getByRole('status')).toHaveCount(0);
    await expect(page.getByText('Live', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '↓ New activity' })).toHaveCount(0);
  });
});

test('given a running workload\'s detail page open in a browser, when its generations complete and are then billed, then the per-call table gains each row, flags a cache miss, and fills in provider, served model and billed cost without a reload', async ({
  dashboard,
  page,
}) => {
  dashboard.store.insertRun(runningRun);
  await openLive(page, '/runs/run-01');
  await expect(page.locator('[data-calls]')).toHaveCount(0);
  const record = (generationId: string, cacheReadTokens: number, cacheWriteTokens: number, estimatedCostUsd: number) =>
    dashboard.store.recordGeneration({
      runId: 'run-01',
      generationId,
      subagent: null,
      kind: 'message',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens, cacheWriteTokens },
      estimatedCostUsd,
      createdAt: '2026-09-21T10:01:00.000Z',
    });

  record('gen-01', 0, 1000, 0.01);
  await page.locator('[data-calls-summary]').click();
  const rows = page.locator('[data-calls] tr[data-call]');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('[data-cost]')).toContainText('estimated');

  record('gen-02', 0, 1010, 0.02);
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toHaveAttribute('data-cache-miss', '');
  await expect(rows.first()).not.toHaveAttribute('data-cache-miss', '');

  const [first] = dashboard.store.unsettledGenerations();
  dashboard.store.recordLookups(
    [{ id: first!.id, billing: { costUsd: 0.25, usage: null, reasoningTokens: 7, provider: 'Novita', model: 'z-ai/glm-5.1' } }],
    '2026-09-21T10:05:00.000Z',
  );
  await expect(rows.first().locator('[data-provider]')).toHaveText('Novita');
  await expect(rows.first().locator('[data-served-model]')).toHaveText('z-ai/glm-5.1');
  await expect(rows.first().locator('[data-reasoning]')).toHaveText('7');
  await expect(rows.first().locator('[data-cost]')).toContainText('billed');

  await expectNotReloaded(page);
});

const cohortFingerprint = (skills: string): ConfigFingerprint => ({
  model: 'anthropic/claude-sonnet-5.5',
  reasoningEffort: 'high',
  harnessArgs: ['--thinking', 'high'],
  harnessVersion: '1.0.0',
  promptTemplate: '3fa2c9d1',
  systemPrompt: 'a'.repeat(64),
  tools: 'b'.repeat(64),
  skills: skills.repeat(64),
});

const firstCohort = cohortFingerprint('c');
const secondCohort = cohortFingerprint('d');
const thirdCohort = cohortFingerprint('e');

const recordCohort = (store: Store, id: string, config: ConfigFingerprint): void => {
  store.insertRun({ ...runningRun, id, worker: 'builder', status: 'success', endTime: '2026-09-21T10:03:00.000Z', costStatus: 'billed' });
  store.recordFingerprint(id, { fingerprint: config, hash: fingerprintHash(config), forgeGitSha: null, baseCommit: null });
};

const respondWith = async (page: Page, rewrite: (body: string) => string): Promise<void> => {
  await page.route(
    (url) => url.pathname !== '/events',
    async (route) => {
      if (route.request().resourceType() !== 'fetch') return route.fallback();
      const response = await route.fetch();
      await route.fulfill({ response, body: rewrite(await response.text()) });
    },
    { times: 1 },
  );
};

test('given a cohort page with another cohort chosen in Compare against but not submitted, when a store write adds a cohort and the page refreshes live, then the chosen cohort stays selected, the new cohort is offered, and submitting compares against the chosen one', async ({
  dashboard,
  page,
}) => {
  recordCohort(dashboard.store, 'one', firstCohort);
  recordCohort(dashboard.store, 'two', secondCohort);
  await openLive(page, `/cohorts/${fingerprintHash(firstCohort)}`);
  const against = page.getByLabel('Compare against');
  await against.selectOption(fingerprintHash(secondCohort));

  recordCohort(dashboard.store, 'three', thirdCohort);

  await expect(against.locator(`option[value="${fingerprintHash(thirdCohort)}"]`)).toBeAttached();
  await expect(against).toHaveValue(fingerprintHash(secondCohort));
  await page.getByRole('button', { name: 'Compare' }).click();
  await expect(page).toHaveURL(new RegExp(`against=${fingerprintHash(secondCohort)}$`));
});

test('given the insights page with the manual workloads filter toggled but not submitted, when a store write changes the data and the page refreshes live, then the checkbox keeps the operator\'s state and the page shows the new data', async ({
  dashboard,
  page,
}) => {
  recordCohort(dashboard.store, 'one', firstCohort);
  await openLive(page, '/insights?manual=1');
  const manual = page.getByLabel('Include manual workloads');
  await expect(manual).toBeChecked();
  await manual.uncheck();

  recordCohort(dashboard.store, 'two', secondCohort);

  await expect(page.locator(`tr[data-cohort="${fingerprintHash(secondCohort)}"]`)).toBeAttached();
  await expect(manual).not.toBeChecked();
});

test('given a form control the operator changed and changed back to its rendered value, when a live refresh renders it in a new server state, then the control shows the new server state', async ({
  dashboard,
  page,
}) => {
  recordCohort(dashboard.store, 'one', firstCohort);
  await openLive(page, '/insights?manual=1');
  const manual = page.getByLabel('Include manual workloads');
  await manual.uncheck();
  await manual.check();
  await respondWith(page, (body) => body.replace('value="1" checked', 'value="1"'));

  recordCohort(dashboard.store, 'two', secondCohort);

  await expect(page.locator(`tr[data-cohort="${fingerprintHash(secondCohort)}"]`)).toBeAttached();
  await expect(manual).not.toBeChecked();
});

test('given a select whose chosen option the operator changed but did not submit, when a live refresh renders the select without that option, then the select shows the server\'s choice', async ({
  dashboard,
  page,
}) => {
  recordCohort(dashboard.store, 'one', firstCohort);
  recordCohort(dashboard.store, 'two', secondCohort);
  await openLive(page, `/cohorts/${fingerprintHash(firstCohort)}`);
  const against = page.getByLabel('Compare against');
  await against.selectOption(fingerprintHash(secondCohort));
  await respondWith(page, (body) => body.replace(new RegExp(`<option value="${fingerprintHash(secondCohort)}"[^>]*>[^<]*</option>`), ''));

  recordCohort(dashboard.store, 'three', thirdCohort);

  await expect(against.locator(`option[value="${fingerprintHash(thirdCohort)}"]`)).toBeAttached();
  await expect(against).toHaveValue('');
});
