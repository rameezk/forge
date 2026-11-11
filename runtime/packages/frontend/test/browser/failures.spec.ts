import { GLM, SONNET, seedStore, type Seed } from '../insights-seed.ts';
import { expect, test } from './dashboard.ts';

const quick = { seconds: 60, cost: 0.1, toolCalls: 1, retries: 0 };

const SEEDS: Seed[] = [
  { id: 'g1', fingerprint: GLM, start: '2026-09-20T10:00:00.000Z', diagnoses: ['skill'], ...quick },
  { id: 's1', fingerprint: SONNET, diagnoses: ['skill'], ...quick },
  { id: 's2', fingerprint: SONNET, diagnoses: ['skill'], ...quick },
  { id: 's3', fingerprint: SONNET, ...quick },
  { id: 's4', fingerprint: SONNET, kind: 'revision', failed: true, diagnoses: ['worker'], ...quick },
];

test('given a cohort with two skill failures, when its Skill count is followed, then Workloads lists exactly those two runs', async ({ dashboard, page }) => {
  seedStore(dashboard.store, SEEDS);
  await page.goto('/insights?tab=failures');
  await expect(page.getByRole('link', { name: 'Failures' })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('[data-causes]')).toBeVisible();
  await expect(page.getByLabel('Kind')).toHaveValue('all');
  await expect(page.getByLabel('Include manual workloads')).toHaveCount(0);

  await page.locator('[data-cohort-group="active"] [data-metric="cause-skill"] a').click();

  await expect(page).toHaveURL(/\/workloads\?.*category=skill/);
  await expect(page.locator('tr[data-run]')).toHaveCount(2);
});

test('given a cohort with diagnosed failures, when its cohort page opens, then it shows that cohort failures', async ({ dashboard, page }) => {
  seedStore(dashboard.store, SEEDS);
  await page.goto('/insights?tab=failures');

  await page.locator('[data-cohort-group="active"] [data-cohort]').first().getByRole('link').first().click();

  const failures = page.locator('[data-failures]');
  await expect(failures.locator('[data-metric="failed"]')).toHaveText('4');
  await expect(failures.locator('[data-metric="diagnosed"]')).toHaveText('3 of 4');
  await expect(failures.locator('[data-metric="cause-skill"]')).toHaveText('2');
});
