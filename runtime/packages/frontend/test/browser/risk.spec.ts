import type { RiskLevel, Store } from '@forge/shared';
import { expect, test } from './dashboard.ts';

const MODEL = 'anthropic/claude-sonnet-5.5';

const LEVELS: RiskLevel[] = ['trivial', 'low', 'moderate', 'high'];

const seedGrades = (store: Store): void => {
  let number = 0;
  for (const level of LEVELS) {
    for (const [outcome, uncertain] of [['merged', false], ['superseded', false], ['closed', false], ['open', false], ['merged', true], ['auto-merged', false]] as const) {
      number += 1;
      store.recordRiskGrade({
        repository: 'forge',
        number,
        headSha: `sha-${number}`,
        fingerprint: `${MODEL}:aaaa`,
        model: MODEL,
        probabilities: { trivial: 0.1, low: 0.1, moderate: 0.1, high: 0.1, [level]: 0.7 },
        score: 1,
        confidence: 0.9,
        level,
        uncertain,
        costUsd: 0.01,
        gradedAt: '2026-09-21T10:00:00.000Z',
      });
      if (outcome !== 'open') store.settleRiskGrade({ repository: 'forge', number, headSha: `sha-${number}` }, outcome, '2026-09-22T10:00:00.000Z');
    }
  }
};

for (const colorScheme of ['light', 'dark'] as const) {
  for (const [name, width] of [['desktop', 1280], ['phone', 375]] as const) {
    test(`given the Risk tab with grades, when it is opened at ${name} width in ${colorScheme}, then the page does not scroll sideways and the table scrolls inside its card`, async ({ dashboard, page }) => {
      seedGrades(dashboard.store);
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/insights?tab=risk');

      await expect(page.locator('[data-risk-row]')).toHaveCount(8);
      await expect(page.locator('[data-risk-row="low"][data-uncertain="false"] [data-metric="auto-merged"]')).toHaveText('1');
      await expect(page.locator('th[title^="Merged at the graded head by forge"]')).toHaveText('Auto-merged');
      expect(await page.locator('html').evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
      const lefts = await page.locator('[data-risk-card]').evaluateAll((cards) => cards.map((card) => Math.round(card.getBoundingClientRect().left)));
      expect(lefts).toHaveLength(3);
      expect(new Set(lefts).size).toBe(width < 500 ? 1 : 2);
      const card = page.locator('[data-risk]');
      const overflow = await card.evaluate((element) => element.scrollWidth - element.clientWidth);
      if (width < 500) expect(overflow).toBeGreaterThan(0);
      else expect(overflow).toBe(0);
    });
  }
}

const seedPause = (store: Store): void => {
  for (let index = 0; index < 20; index += 1) {
    const number = 700 + index;
    store.recordRiskGrade({
      repository: 'forge',
      number,
      headSha: `paused-${number}`,
      fingerprint: `${MODEL}:aaaa`,
      model: MODEL,
      probabilities: { trivial: 0.1, low: 0.7, moderate: 0.1, high: 0.1 },
      score: 1,
      confidence: 0.9,
      level: 'low',
      uncertain: false,
      costUsd: 0.01,
      gradedAt: '2026-09-21T10:00:00.000Z',
    });
    store.settleRiskGrade({ repository: 'forge', number, headSha: `paused-${number}` }, index < 3 ? 'closed' : 'merged', `2026-09-22T10:${String(index).padStart(2, '0')}:00.000Z`);
  }
};

for (const colorScheme of ['light', 'dark'] as const) {
  for (const [name, width] of [['desktop', 1280], ['phone', 375]] as const) {
    test(`given 17 of the last 20 human-reviewed grades held up, when the Risk tab is opened at ${name} width in ${colorScheme}, then the auto-merge card shows paused, the band links to it and nothing scrolls sideways`, async ({ dashboard, page }) => {
      seedPause(dashboard.store);
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/insights?tab=risk');

      const card = page.locator('[data-risk-card="auto-merge"]');
      await expect(card).toHaveAttribute('data-state', 'paused');
      await expect(card).toContainText('85.0%');
      await expect(card).toContainText('17 of 20');
      await expect(card).toContainText('90% bar');
      await expect(page.locator('[data-auto-merge-paused]')).toContainText('Eligible pull requests wait for review');
      expect(await page.locator('html').evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
      await page.locator('[data-auto-merge-paused] a').click();
      await expect(page).toHaveURL(/#auto-merge$/);
      await page.screenshot({ path: `test-results/auto-merge-${name}-${colorScheme}.png`, fullPage: true });
    });
  }
}
