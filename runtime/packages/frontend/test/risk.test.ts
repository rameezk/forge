import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GradeOutcome, GradingFailure, RiskLevel, Store, SupersedeCause } from '@forge/shared';
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
  cause?: SupersedeCause;
  cost?: number;
  revisions?: number;
}

let heads = 0;

const grade = (store: Store, grading: Grading = {}): void => {
  heads += 1;
  const { repository = 'forge', number = heads, head = `sha-${heads}`, level = 'low', unsettled = false, confidence = 0.9, fingerprint = CURRENT, at = '2026-09-21T10:00:00.000Z', outcome = 'open', cause = 'unknown', cost = 0.01, revisions = 0 } = grading;
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
    costUsd: cost,
    gradedAt: at,
  });
  for (let index = 0; index < revisions; index += 1) {
    const start = store.startRevision({ repository, number, url: `https://github.com/rameezk/${repository}/pull/${number}` }, [], `run-${heads}-${index}`, at, Number.POSITIVE_INFINITY);
    assert.ok('started' in start);
    store.endRevision(start.started, 'done', at);
  }
  if (outcome === 'open') return;
  const settling = { repository, number, headSha: head };
  if (outcome !== 'superseded' || cause === 'unknown') return store.settleRiskGrade(settling, outcome, at);
  const superseding = `${head}-superseding`;
  if (cause === 'revision') pushedBy(store, 'revision', repository, number, superseding);
  if (cause === 'conflict-resolution') pushedBy(store, 'conflict-resolution', repository, number, superseding);
  store.settleRiskGrade(settling, outcome, at, superseding);
};

const pushedBy = (store: Store, kind: 'revision' | 'conflict-resolution', repository: string, number: number, pushed: string): void => {
  const pullRequest = { repository, number, url: `https://github.com/rameezk/${repository}/pull/${number}` };
  const startedAt = '2026-09-21T11:00:00.000Z';
  if (kind === 'revision') {
    const start = store.startRevision(pullRequest, [], `run-${pushed}`, startedAt, Number.POSITIVE_INFINITY);
    assert.ok('started' in start);
    store.recordRevisionPush(start.started, pushed);
    store.endRevision(start.started, 'done', startedAt);
    return;
  }
  const start = store.startConflictResolution(pullRequest, [], `run-${pushed}`, startedAt, Number.POSITIVE_INFINITY, { headSha: 'before', defaultSha: 'default' });
  assert.ok('started' in start);
  store.recordConflictResolutionPush(start.started, pushed);
  store.endConflictResolution(start.started, 'done', startedAt);
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

test('given 4 merged low grades, 1 superseded by revision, 1 by conflict resolution, 1 closed and 1 open, when the Risk tab loads, then the low row shows held up 4 / 6 with the conflict resolution and the open grade as counts only', async () => {
  const { store, page } = dashboard([]);
  many(store, 4, { outcome: 'merged' });
  many(store, 1, { outcome: 'superseded', cause: 'revision' });
  many(store, 1, { outcome: 'superseded', cause: 'conflict-resolution' });
  many(store, 1, { outcome: 'closed' });
  many(store, 1, {});

  const row = rowOf(await page('?tab=risk'), 'low');

  assert.deepEqual(row, {
    'held-up': '66.7% 4 / 6',
    heads: '8',
    prs: '8',
    merged: '4',
    'superseded-revision': '1',
    'superseded-other': '0',
    'superseded-conflict-resolution': '1',
    'superseded-unknown': '0',
    closed: '1',
    open: '1',
    confidence: '0.90',
    revisions: '0.00',
  });
});

test('given a settled trivial grade superseded before causes were recorded, when the Risk tab loads, then it shows under Unknown and counts in the held up denominator', async () => {
  const { store, page } = dashboard([]);
  grade(store, { level: 'trivial', outcome: 'merged' });
  grade(store, { level: 'trivial', outcome: 'superseded', cause: 'unknown' });
  grade(store, { level: 'trivial', outcome: 'superseded', cause: 'other' });

  const row = rowOf(await page('?tab=risk'), 'trivial');

  assert.equal(row['superseded-unknown'], '1');
  assert.equal(row['superseded-other'], '1');
  assert.equal(row['held-up'], '33.3% 1 / 3');
});

test('given only conflict resolution supersedes settled, when the Risk tab loads, then the held up rate has nothing to judge', async () => {
  const { store, page } = dashboard([]);
  grade(store, { outcome: 'superseded', cause: 'conflict-resolution' });

  const row = rowOf(await page('?tab=risk'), 'low');

  assert.equal(row['superseded-conflict-resolution'], '1');
  assert.equal(row['held-up'], 'n/a 0 / 0');
});

test('given the Superseded by group, when the Risk tab loads, then Conflict res. and Unknown are muted and each cause header explains on hover how it is treated', async () => {
  const { store, page } = dashboard([]);
  grade(store, { outcome: 'superseded', cause: 'revision' });

  const body = await page('?tab=risk');

  const headers = [...body.matchAll(/<th[^>]*data-superseded-by="([^"]+)"[^>]*title="([^"]+)"/g)].map((match) => [match[1], match[2]]);
  assert.deepEqual(headers.map(([cause]) => cause), ['revision', 'other', 'conflict-resolution', 'unknown']);
  assert.match(headers[0]![1]!, /counts against the grade/i);
  assert.match(headers[1]![1]!, /counts against the grade/i);
  assert.match(headers[2]![1]!, /neutral/i);
  assert.match(headers[3]![1]!, /counts against the grade/i);
  const row = body.match(/<tr[^>]*data-risk-row="low"[^>]*data-unsettled="false"[^>]*>[\s\S]*?<\/tr>/)![0];
  assert.match(row, /text-muted[^>]*data-metric="superseded-conflict-resolution"/);
  assert.match(row, /text-muted[^>]*data-metric="superseded-unknown"/);
  assert.doesNotMatch(row, /text-muted[^>]*data-metric="superseded-revision"/);
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

test('given a footnote, when the Risk tab loads, then it defines held up and says conflict resolution supersedes are left out', async () => {
  const { store, page } = dashboard([]);
  grade(store, {});

  const note = textOf(await page('?tab=risk'));

  assert.match(note, /Held up is the share of settled grades merged at the graded head, leaving out those superseded by a conflict resolution/);
  assert.match(note, /Conflict resolution supersedes are counted only/);
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

const cardOf = (page: string, name: string): string =>
  textOf(page.match(new RegExp(`<section[^>]*\\sdata-risk-card="${name}"[^>]*>[\\s\\S]*?</section>`))?.[0] ?? '');

const fail = (store: Store, category: GradingFailure, head: string, repository = 'forge', number = 900, attemptedAt = '2026-09-21T09:00:00.000Z'): void =>
  store.recordGradingAttempt({ repository, number, headSha: head, attemptedAt, category, message: category });

test('given 9 graded heads and 1 head with only a too-large attempt, when the Risk tab loads, then coverage shows 90.0% with too large 1', async () => {
  const { store, page } = dashboard([]);
  many(store, 9, { outcome: 'merged' });
  fail(store, 'too-large', 'ungraded');

  const card = cardOf(await page('?tab=risk'), 'coverage');

  assert.match(card, /90\.0%/);
  assert.match(card, /9 of 10/);
  assert.match(card, /Too large 1/);
  assert.match(card, /Temporary 0/);
});

test('given a head with a temporary attempt that was later graded, when the Risk tab loads, then it counts as graded and not as a failed attempt', async () => {
  const { store, page } = dashboard([]);
  grade(store, { number: 7, head: 'retried' });
  fail(store, 'temporary', 'retried', 'forge', 7);

  const card = cardOf(await page('?tab=risk'), 'coverage');

  assert.match(card, /100\.0%/);
  assert.match(card, /1 of 1/);
  assert.match(card, /Temporary 0/);
});

test('given a head with several failed attempts, when the Risk tab loads, then it counts once under the category of its latest attempt', async () => {
  const { store, page } = dashboard([]);
  grade(store, {});
  fail(store, 'temporary', 'stuck', 'forge', 900, '2026-09-21T08:00:00.000Z');
  fail(store, 'declined', 'stuck', 'forge', 900, '2026-09-21T09:00:00.000Z');

  const card = cardOf(await page('?tab=risk'), 'coverage');

  assert.match(card, /50\.0%/);
  assert.match(card, /Declined 1/);
  assert.match(card, /Temporary 0/);
});

test('given two grades costing $0.002 and $0.004, when the Risk tab loads, then the cost card shows a $0.006 total and $0.003 per grade', async () => {
  const { store, page } = dashboard([]);
  grade(store, { cost: 0.002 });
  grade(store, { cost: 0.004 });

  const card = cardOf(await page('?tab=risk'), 'cost');

  assert.match(card, /\$0\.006 total/);
  assert.match(card, /\$0\.003 per grade/);
});

test('given settled trivial and low grades with 79 merged as graded out of 93 counted, plus unsettled and moderate grades, when the Risk tab loads, then the candidates card shows 84.9% (79 of 93) with the assumption footnote', async () => {
  const { store, page } = dashboard([]);
  many(store, 40, { level: 'trivial', outcome: 'merged' });
  many(store, 39, { level: 'low', outcome: 'merged' });
  many(store, 8, { level: 'trivial', outcome: 'superseded', cause: 'revision' });
  many(store, 6, { level: 'low', outcome: 'closed' });
  many(store, 3, { level: 'low', outcome: 'superseded', cause: 'conflict-resolution' });
  many(store, 5, { level: 'low', unsettled: true, outcome: 'merged' });
  many(store, 5, { level: 'moderate', outcome: 'closed' });

  const card = cardOf(await page('?tab=risk'), 'candidates');

  assert.match(card, /84\.9%/);
  assert.match(card, /79 of 93/);
  assert.match(card, /Assumes auto-merge would take settled trivial and low grades and nothing unsettled\./);
});

test('given grades in two repositories, when the tab is filtered to one repository, then all three cards count only that repository', async () => {
  const { store, page } = dashboard([]);
  many(store, 2, { repository: 'forge', outcome: 'merged', cost: 0.002 });
  many(store, 2, { repository: 'site', outcome: 'closed', cost: 0.01 });
  fail(store, 'setup', 'forge-ungraded', 'forge', 901);
  fail(store, 'setup', 'site-ungraded', 'site', 902);
  fail(store, 'setup', 'site-ungraded-too', 'site', 903);

  const body = await page('?tab=risk&repository=forge');

  assert.match(cardOf(body, 'coverage'), /66\.7%[\s\S]*2 of 3[\s\S]*Setup 1/);
  assert.match(cardOf(body, 'cost'), /\$0\.004 total/);
  assert.match(cardOf(body, 'candidates'), /100\.0%[\s\S]*2 of 2/);
});

test('given the Risk tab with grades, when it loads, then the three cards precede the table', async () => {
  const { store, page } = dashboard([]);
  grade(store, {});

  const body = await page('?tab=risk');

  const order = [...body.matchAll(/data-risk-card="([^"]+)"|data-risk(?=[\s>])/g)].map((match) => match[1] ?? 'table');
  assert.deepEqual(order, ['coverage', 'cost', 'candidates', 'table']);
});

test('given two settled low grades with 0 and 1 revisions after grade and an open low grade, when the Risk tab loads, then the low row shows revisions after grade 0.50', async () => {
  const { store, page } = dashboard([]);
  grade(store, { outcome: 'merged' });
  grade(store, { outcome: 'superseded', revisions: 1 });
  grade(store, {});

  const body = await page('?tab=risk');

  assert.equal(rowOf(body, 'low').revisions, '0.50');
  assert.match(textOf(body), /Revisions after grade is the mean number of completed revisions that started after the grade and before its outcome, over settled grades/);
});

test('given a level with no settled grades, when the Risk tab loads, then its row shows no revisions after grade', async () => {
  const { store, page } = dashboard([]);
  grade(store, { level: 'high' });

  assert.equal(rowOf(await page('?tab=risk'), 'high').revisions, 'n/a');
});
