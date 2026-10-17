import type { Page } from '@playwright/test';
import type { RunRecord } from '@forge/shared';
import { formatDuration } from '../../src/format.ts';
import { expect, test } from './dashboard.ts';

const START = '2026-09-21T10:00:00.000Z';

const runningRun: RunRecord = {
  id: 'run-01',
  worker: 'builder',
  harness: 'pi',
  model: 'anthropic/claude-opus-4',
  reasoningEffort: null,
  startTime: START,
  endTime: null,
  status: 'running',
  costStatus: 'pending',
  costUsd: 0,
  costEstimated: false,
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

const minutesAfterStart = (minutes: number): Date => new Date(Date.parse(START) + minutes * 60_000);

const openAt = async (page: Page, now: Date, path: string): Promise<void> => {
  await page.clock.install({ time: now });
  await page.goto(path);
  await expect(page.getByRole('status')).toHaveText('Live');
};

test('given a running workload, when time passes in the browser, then its elapsed time advances on the runs table and the run page without a reload, reading in hours past an hour', async ({
  dashboard,
  page,
}) => {
  dashboard.store.insertRun(runningRun);
  await openAt(page, minutesAfterStart(45), '/workloads');
  const listed = page.getByRole('row', { name: /builder/ }).locator('[data-duration]');
  await expect(listed).toHaveText('45m 0s');

  await page.clock.runFor(5_000);
  await expect(listed).toHaveText('45m 5s');

  await page.clock.fastForward(30 * 60_000 + 20_000);
  await expect(listed).toHaveText('1h 15m');

  await page.goto('/runs/run-01');
  await expect(page.locator('[data-duration]')).toHaveText('1h 15m');
  await page.clock.fastForward(61 * 60_000);
  await expect(page.locator('[data-duration]')).toHaveText('2h 16m');
});

test('given a running workload whose elapsed time is ticking, when it ends, then the page shows its final duration and stops advancing', async ({
  dashboard,
  page,
}) => {
  dashboard.store.insertRun(runningRun);
  await openAt(page, minutesAfterStart(5), '/runs/run-01');
  const duration = page.locator('[data-duration]');
  await expect(duration).toHaveText('5m 0s');

  dashboard.store.finalizeRun('run-01', {
    status: 'success',
    endTime: '2026-09-21T10:03:20.000Z',
    sessionId: null,
    error: null,
  });

  await expect(duration).toHaveText('3m 20s');
  await page.clock.runFor(60_000);
  await expect(duration).toHaveText('3m 20s');
});

test('given a running dispatch and a finished one, when the Board renders and time passes, then the running card\'s elapsed time and the revising card\'s elapsed time advance while the in-review card without a revision shows none', async ({
  dashboard,
  page,
}) => {
  const ticket = (number: number) => ({ number, title: `Ticket ${number}`, url: `https://github.com/rameezk/forge/issues/${number}`, parent: null, createdAt: '2026-09-20T10:00:00Z', forgeReady: false, forHuman: false, blocked: false, blockedBy: [] });
  dashboard.store.replaceFrontier({ repository: 'forge', github: 'rameezk/forge', polledAt: START, closed: [], requests: [], tickets: [ticket(56), ticket(57), ticket(58)] });
  const began = new Date();
  const dispatch = (number: number) => {
    const started = dashboard.store.startDispatch({ repository: 'forge', number, url: ticket(number).url }, `run-${number}`, began.toISOString(), Number.POSITIVE_INFINITY);
    if (!('started' in started)) throw new Error('dispatch refused');
    return started.started;
  };
  dispatch(56);
  const pullRequest = (number: number) => ({ number, url: `https://github.com/rameezk/forge/pull/${number}` });
  dashboard.store.endDispatch(dispatch(57), { state: 'done', pullRequest: pullRequest(143) }, new Date(began.getTime() + 5 * 60_000).toISOString());
  dashboard.store.endDispatch(dispatch(58), { state: 'done', pullRequest: pullRequest(144) }, new Date(began.getTime() + 5 * 60_000).toISOString());
  dashboard.store.insertRun({ ...runningRun, id: 'revision-143', startTime: new Date(began.getTime() + 50 * 60_000).toISOString(), harnessStartTime: new Date(began.getTime() + 60 * 60_000).toISOString() });
  dashboard.store.startRevision({ repository: 'forge', ...pullRequest(143) }, [57], 'revision-143', began.toISOString(), Number.POSITIVE_INFINITY);
  await openAt(page, new Date(began.getTime() + 125 * 60_000), '/');
  const running = page.locator('[data-ticket="56"] [data-elapsed-since]');
  const open = page.locator('[data-ticket="57"] [data-elapsed-since]');
  await expect(running).toHaveText('2h 5m');
  await expect(open).toHaveText('1h 5m');
  await expect(page.locator('[data-ticket="58"] [data-elapsed-since]')).toHaveCount(0);

  await page.clock.fastForward(10 * 60_000);

  await expect(running).toHaveText('2h 15m');
  await expect(open).toHaveText('1h 15m');
  await page.clock.runFor(60_000);
  await expect(running).toHaveText('2h 16m');
  await expect(open).toHaveText('1h 16m');
});

test('given running workloads at several elapsed times, when the browser counts them, then each reads exactly as the server renders the same duration', async ({
  dashboard,
  page,
}) => {
  const now = minutesAfterStart(200);
  const elapsedSeconds = [0, 59, 60, 3599, 3600, 8140, 90_000];
  const startedAt = (seconds: number): string => new Date(now.getTime() - seconds * 1000).toISOString();
  for (const seconds of elapsedSeconds) {
    dashboard.store.insertRun({ ...runningRun, id: `run-${seconds}`, worker: `worker-${seconds}s`, startTime: startedAt(seconds) });
  }

  await openAt(page, now, '/workloads');

  for (const seconds of elapsedSeconds) {
    await expect(page.getByRole('row', { name: new RegExp(`worker-${seconds}s `) }).locator('[data-duration]')).toHaveText(
      formatDuration(startedAt(seconds), now.toISOString()),
    );
  }
});

test('given a running workload with a 2 hour timeout whose harness started 45 minutes ago, when its run renders and time passes, then its elapsed time reads against the timeout, counted from the harness start, on the runs table and the run page', async ({
  dashboard,
  page,
}) => {
  dashboard.store.insertRun({
    ...runningRun,
    timeoutSeconds: 7200,
    harnessStartTime: '2026-09-21T10:10:00.000Z',
  });
  await openAt(page, minutesAfterStart(55), '/workloads');
  const listed = page.getByRole('row', { name: /builder/ }).locator('[data-duration]');
  await expect(listed).toHaveText('45m / 2h');

  await page.clock.fastForward(5_000);
  await expect(listed).toHaveText('45m / 2h');
  await page.clock.fastForward(76 * 60_000);
  await expect(listed).toHaveText('2h 1m / 2h');

  await page.goto('/runs/run-01');
  await expect(page.locator('[data-duration]')).toHaveText('2h 1m / 2h');
});
