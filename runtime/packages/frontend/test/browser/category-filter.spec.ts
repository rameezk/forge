import type { DiagnosisCategory, RunRecord } from '@forge/shared';
import { expect, test } from './dashboard.ts';

const aRun = (id: string, worker: string, number: number): RunRecord => ({
  id,
  worker,
  harness: 'pi',
  model: 'z-ai/glm-5',
  reasoningEffort: null,
  startTime: '2026-11-01T10:00:00.000Z',
  endTime: '2026-11-01T10:03:20.000Z',
  status: 'success',
  costStatus: 'billed',
  costUsd: 0.12,
  costEstimated: false,
  unconfirmedEstimateUsd: 0,
  listPrice: null,
  inputTokens: 10,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  transcriptRef: null,
  sessionId: null,
  error: null,
  ticket: { repository: 'forge', number, url: `https://github.com/rameezk/forge/issues/${number}` },
  aliveAt: null,
  harnessStartTime: null,
  timeoutSeconds: null,
  maxCostUsd: null,
  exceededLimit: null,
  counters: null,
});

const AT = '2026-11-01T11:00:00.000Z';

test('given failed runs diagnosed as skill, skill and forge, when Workloads is filtered to Forge and its link is opened in a fresh browser, then the Forge filter is applied', async ({
  dashboard,
  page,
  browser,
}) => {
  const failed = (id: string, number: number, categories: DiagnosisCategory[]) => {
    dashboard.store.insertRun(aRun(id, 'builder', number));
    const dispatch = dashboard.store.startDispatch({ repository: 'forge', number, url: `https://github.com/rameezk/forge/issues/${number}` }, id, '2026-11-01T10:00:00.000Z', 10, null);
    if (!('started' in dispatch)) throw new Error('dispatch did not start');
    dashboard.store.endDispatch(dispatch.started, { state: 'failed', reason: 'check-failed', detail: 'build' }, '2026-11-01T10:03:20.000Z');
    categories.forEach((category, index) => {
      dashboard.store.insertRun(aRun(`${id}-diagnosis-${index}`, 'diagnoser', number));
      dashboard.store.endDiagnosis(dashboard.store.startDiagnosis(id, `${id}-diagnosis-${index}`, AT), 'done', AT, {
        verdict: { category, evidence: [{ turn: 1, note: 'seen' }], suggestedFix: 'fix it' },
      });
    });
  };
  failed('skill-a', 1, ['skill']);
  failed('skill-b', 2, ['skill']);
  failed('forge-a', 3, ['forge']);

  await page.goto('/workloads');
  await page.getByLabel('Diagnosis').selectOption('forge');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.locator('tr[data-run]')).toHaveCount(1);
  await expect(page.locator('tr[data-run="forge-a"]')).toBeVisible();

  const fresh = await browser.newContext();
  const other = await fresh.newPage();
  await other.goto(`${dashboard.url}${new URL(page.url()).pathname}${new URL(page.url()).search}`);
  await expect(other.getByLabel('Diagnosis')).toHaveValue('forge');
  await expect(other.locator('tr[data-run]')).toHaveCount(1);
  await fresh.close();
});
