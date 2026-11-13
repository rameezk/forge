import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GradeOutcome, RiskLevel, Store } from '@forge/shared';
import { textOf } from './html.ts';
import { dashboard } from './insights-seed.ts';

const MODEL = 'anthropic/claude-sonnet-5.5';

const CURRENT = `${MODEL}:aaaa`;

const PREVIOUS = `${MODEL}:bbbb`;

interface Grading {
  repository?: string;
  number?: number;
  head?: string;
  level?: RiskLevel;
  unsettled?: boolean;
  confidence?: number;
  fingerprint?: string;
  at?: string;
  outcome?: GradeOutcome;
}

let heads = 0;

const grade = (store: Store, grading: Grading = {}): void => {
  heads += 1;
  const { repository = 'forge', number = heads, head = `sha-${heads}`, level = 'low', unsettled = false, confidence = 0.9, fingerprint = CURRENT, at = '2026-09-21T10:00:00.000Z', outcome = 'open' } = grading;
  store.recordRiskGrade({
    repository,
    number,
    headSha: head,
    fingerprint,
    model: MODEL,
    probabilities: { trivial: 0.1, low: 0.1, moderate: 0.1, high: 0.1, [level]: 0.7 },
    score: 1,
    confidence,
    level,
    unsettled,
    costUsd: 0.01,
    gradedAt: at,
  });
  if (outcome !== 'open') store.settleRiskGrade({ repository, number, headSha: head }, outcome, at);
};

const many = (store: Store, count: number, grading: Grading): void => {
  for (let index = 0; index < count; index += 1) grade(store, grading);
};

const rowOf = (page: string, level: string, unsettled = false): Record<string, string> => {
  const row = page.match(new RegExp(`<tr[^>]*\\sdata-risk-row="${level}"[^>]*\\sdata-unsettled="${unsettled}"[^>]*>([\\s\\S]*?)</tr>`))?.[1] ?? '';
  return Object.fromEntries([...row.matchAll(/<td[^>]*\sdata-metric="([^"]+)"[^>]*>([\s\S]*?)<\/td>/g)].map(([, name, cell]) => [name!, textOf(cell!)]));
};

test('given the Insights page, when it loads, then a Risk tab follows Delivery, Cost and Failures and opens the risk view', async () => {
  const { store, page } = dashboard([]);
  grade(store, {});

  const body = await page('?tab=risk');

  assert.deepEqual([...body.matchAll(/<a[^>]*\sdata-tab="([^"]+)"/g)].map((match) => match[1]), ['delivery', 'cost', 'failures', 'risk']);
  assert.match(body, /data-tab="risk" aria-current="page"/);
  assert.match(body, /data-risk/);
});

test('given 4 merged, 1 superseded, 1 closed and 1 open low grade, when the Risk tab loads, then the low row shows held up 4 / 6, 1 unknown and 1 open', async () => {
  const { store, page } = dashboard([]);
  many(store, 4, { outcome: 'merged' });
  many(store, 1, { outcome: 'superseded' });
  many(store, 1, { outcome: 'closed' });
  many(store, 1, {});

  const row = rowOf(await page('?tab=risk'), 'low');

  assert.deepEqual(row, {
    'held-up': '66.7% 4 / 6',
    heads: '7',
    prs: '7',
    merged: '4',
    'superseded-unknown': '1',
    closed: '1',
    open: '1',
    confidence: '0.90',
  });
});

test('given an unsettled and a settled low grade, when the Risk tab loads, then each has its own low row and the unsettled one carries the unsettled pill', async () => {
  const { store, page } = dashboard([]);
  grade(store, { outcome: 'merged' });
  grade(store, { unsettled: true, outcome: 'closed' });

  const body = await page('?tab=risk');

  assert.equal(rowOf(body, 'low')['held-up'], '100.0% 1 / 1');
  assert.equal(rowOf(body, 'low', true)['held-up'], '0.0% 0 / 1');
  assert.match(body.match(/<tr[^>]*data-risk-row="low"[^>]*data-unsettled="true"[^>]*>[\s\S]*?<\/tr>/)![0], /data-unsettled-pill[^>]*>\s*unsettled/);
  assert.doesNotMatch(body.match(/<tr[^>]*data-risk-row="low"[^>]*data-unsettled="false"[^>]*>[\s\S]*?<\/tr>/)![0], /data-unsettled-pill/);
});

test('given grades at every level, when the Risk tab loads, then trivial and low sit under Auto-merge candidates and moderate and high under Reviewed by a human in the loop', async () => {
  const { store, page } = dashboard([]);
  for (const level of ['trivial', 'low', 'moderate', 'high'] as const) grade(store, { level });

  const body = await page('?tab=risk');

  const order = [...body.matchAll(/data-risk-group="([^"]+)"|data-risk-row="([^"]+)" data-unsettled="false"/g)].map((match) => match[1] ?? match[2]);
  assert.deepEqual(order, ['candidates', 'trivial', 'low', 'human', 'moderate', 'high']);
  assert.match(textOf(body), /Auto-merge candidates/);
  assert.match(textOf(body), /Reviewed by a human in the loop/);
});

test('given one pull request with two heads graded low, when the Risk tab loads, then the low row shows 2 heads and 1 PR', async () => {
  const { store, page } = dashboard([]);
  grade(store, { number: 5, head: 'one' });
  grade(store, { number: 5, head: 'two' });

  const row = rowOf(await page('?tab=risk'), 'low');

  assert.equal(row['heads'], '2');
  assert.equal(row['prs'], '1');
});

test('given settled trivial grades with confidences 0.80, 0.90 and 0.95, when the Risk tab loads, then the trivial row shows median confidence 0.90', async () => {
  const { store, page } = dashboard([]);
  for (const confidence of [0.8, 0.9, 0.95]) grade(store, { level: 'trivial', confidence, outcome: 'merged' });

  assert.equal(rowOf(await page('?tab=risk'), 'trivial')['confidence'], '0.90');
});

test('given a footnote, when the Risk tab loads, then it defines held up', async () => {
  const { store, page } = dashboard([]);
  grade(store, {});

  assert.match(textOf(await page('?tab=risk')), /Held up is the share of settled grades merged at the graded head/);
});

const optionsOf = (body: string, name: string): string[] => {
  const select = body.match(new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`))?.[1] ?? '';
  return [...select.matchAll(/<option[^>]*value="([^"]*)"/g)].map((match) => match[1]!);
};

test('given grades under two grading fingerprints, when the Risk tab loads with no cohort chosen, then only the current cohort is counted and the selector offers the other', async () => {
  const { store, page } = dashboard([]);
  grade(store, { fingerprint: PREVIOUS, at: '2026-09-01T10:00:00.000Z' });
  many(store, 2, { fingerprint: CURRENT, at: '2026-09-21T10:00:00.000Z' });

  const body = await page('?tab=risk');

  assert.equal(rowOf(body, 'low')['heads'], '2');
  assert.deepEqual(optionsOf(body, 'cohort'), [CURRENT, PREVIOUS]);
  assert.match(body, new RegExp(`<option value="${CURRENT}" selected`));
  assert.equal(rowOf(await page(`?tab=risk&cohort=${PREVIOUS}`), 'low')['heads'], '1');
});

test('given grades in two repositories and across two months, when the tab is filtered to one repository and a date range, then only grades of that repository made in that range are counted', async () => {
  const { store, page } = dashboard([]);
  grade(store, { repository: 'forge', at: '2026-08-10T10:00:00.000Z' });
  many(store, 2, { repository: 'forge', at: '2026-09-10T10:00:00.000Z' });
  many(store, 4, { repository: 'site', at: '2026-09-10T10:00:00.000Z' });

  const body = await page('?tab=risk&repository=forge&from=2026-09-01&to=2026-09-30');

  assert.equal(rowOf(body, 'low')['heads'], '2');
  assert.deepEqual(optionsOf(body, 'repository'), ['', 'forge', 'site']);
});

test('given no grades in the selected range, when the Risk tab loads, then it shows No risk grades in this range', async () => {
  const { store, page } = dashboard([]);
  grade(store, { at: '2026-08-10T10:00:00.000Z' });

  const body = await page('?tab=risk&from=2026-09-01');

  assert.match(textOf(body), /No risk grades in this range/);
  assert.doesNotMatch(body, /data-risk-row/);
});

test('given the Risk tab, when it loads, then it offers no worker, kind or manual filter', async () => {
  const { page } = dashboard([]);

  const body = await page('?tab=risk');

  assert.doesNotMatch(body, /name="(worker|kind|manual)"/);
});
