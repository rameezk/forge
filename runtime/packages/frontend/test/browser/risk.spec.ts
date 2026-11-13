import type { RiskLevel, Store } from '@forge/shared';
import { expect, test } from './dashboard.ts';

const MODEL = 'anthropic/claude-sonnet-5.5';

const LEVELS: RiskLevel[] = ['trivial', 'low', 'moderate', 'high'];

const seedGrades = (store: Store): void => {
  let number = 0;
  for (const level of LEVELS) {
    for (const [outcome, unsettled] of [['merged', false], ['superseded', false], ['closed', false], ['open', false], ['merged', true]] as const) {
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
        unsettled,
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
      expect(await page.locator('html').evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
      const lefts = await page.locator('[data-risk-card]').evaluateAll((cards) => cards.map((card) => Math.round(card.getBoundingClientRect().left)));
      expect(lefts).toHaveLength(3);
      expect(new Set(lefts).size).toBe(width < 500 ? 1 : 3);
      const card = page.locator('[data-risk]');
      const overflow = await card.evaluate((element) => element.scrollWidth - element.clientWidth);
      if (width < 500) expect(overflow).toBeGreaterThan(0);
      else expect(overflow).toBe(0);
    });
  }
}
