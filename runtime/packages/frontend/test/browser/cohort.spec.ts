import { fingerprintHash } from '@forge/shared';
import type { ConfigFingerprint, RunRecord, Store } from '@forge/shared';
import { expect, test } from './dashboard.ts';

const fingerprint: ConfigFingerprint = {
  model: 'anthropic/claude-sonnet-5.5',
  reasoningEffort: 'high',
  harnessArgs: ['--thinking', 'high'],
  harnessVersion: '1.0.0',
  promptTemplate: '3fa2c9d1',
  systemPrompt: 'a'.repeat(64),
  tools: 'b'.repeat(64),
  skills: 'c'.repeat(64),
};

const reskilled: ConfigFingerprint = { ...fingerprint, skills: 'd'.repeat(64) };

const workload = (id: string): RunRecord => ({
  id,
  worker: 'builder',
  harness: 'pi',
  model: fingerprint.model,
  reasoningEffort: 'high',
  startTime: '2026-09-21T10:00:00.000Z',
  endTime: '2026-09-21T10:03:00.000Z',
  status: 'success',
  costStatus: 'billed',
  costUsd: 0.1,
  costEstimated: false,
  listPrice: null,
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 300,
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
  counters: { toolCalls: 4, failedToolResults: 0, retries: 0, compactions: 0 },
});

const record = (store: Store, id: string, config: ConfigFingerprint): void => {
  store.insertRun(workload(id));
  store.recordFingerprint(id, { fingerprint: config, hash: fingerprintHash(config), forgeGitSha: null, baseCommit: null });
};

test('given two cohorts, when a cohort label is followed from the insights page and the other cohort is chosen, then the diff marks only the changed field', async ({
  dashboard,
  page,
}) => {
  record(dashboard.store, 'one', fingerprint);
  record(dashboard.store, 'two', reskilled);
  await page.goto('/insights?manual=1');

  await page.locator(`[data-cohort="${fingerprintHash(fingerprint)}"]`).getByRole('link').click();
  await page.getByLabel('Compare against').selectOption(fingerprintHash(reskilled));
  await page.getByRole('button', { name: 'Compare' }).click();

  await expect(page).toHaveURL(new RegExp(`/cohorts/${fingerprintHash(fingerprint)}\\?against=${fingerprintHash(reskilled)}$`));
  await expect(page.locator('[data-field][data-changed="true"]')).toHaveCount(1);
  await expect(page.locator('[data-field="skills"]')).toHaveAttribute('data-changed', 'true');
});

test('given a cohort page with a comparison, when it is opened at phone width, then the page does not scroll sideways', async ({ dashboard, page }) => {
  record(dashboard.store, 'one', fingerprint);
  record(dashboard.store, 'two', reskilled);
  await page.setViewportSize({ width: 375, height: 800 });

  await page.goto(`/cohorts/${fingerprintHash(fingerprint)}?against=${fingerprintHash(reskilled)}`);

  await expect(page.locator('[data-field="skills"]')).toBeVisible();
  expect(await page.locator('html').evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
});
