import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintHash } from '@forge/shared';
import type { ConfigFingerprint } from '@forge/shared';
import { textOf } from './html.ts';
import { dashboard, GLM, SONNET, type Seed } from './insights-seed.ts';

type Row = Record<string, string>;

const rowsOf = (page: string): Map<string, Row> =>
  new Map(
    [...page.matchAll(/<tr[^>]*\sdata-cohort="([^"]*)"[^>]*>([\s\S]*?)<\/tr>/g)].map(([, key, body]) => [
      key!,
      Object.fromEntries(
        [...body!.matchAll(/<td[^>]*\sdata-metric="([^"]+)"[^>]*>([\s\S]*?)<\/td>/g)].map(([, name, cell]) => [
          name!,
          textOf(cell!),
        ]),
      ),
    ]),
  );

const COHORT_SEEDS: Seed[] = [
  { id: 'a1', fingerprint: SONNET, seconds: 60, cost: 0.1, cacheReadTokens: 300, toolCalls: 10, retries: 0, pullRequest: { state: 'merged', rework: 1 } },
  { id: 'a2', fingerprint: SONNET, seconds: 120, cost: 0.2, cacheReadTokens: 300, toolCalls: 20, retries: 1, pullRequest: { state: 'merged', rework: 3 } },
  { id: 'a3', fingerprint: SONNET, seconds: 180, cost: 0.3, cacheReadTokens: 300, toolCalls: 30, retries: 1, pullRequest: { state: 'open', rework: 0 } },
  { id: 'a4', fingerprint: SONNET, seconds: 240, cost: 0.4, cacheReadTokens: 300, toolCalls: 40, retries: 2 },
  { id: 'b1', fingerprint: GLM, seconds: 300, cost: 0.5, inputTokens: 200, cacheWriteTokens: 200, toolCalls: 5, retries: 0, pullRequest: { state: 'merged', rework: 0 } },
  { id: 'b2', fingerprint: GLM, seconds: 100, cost: 0.3, inputTokens: 200, cacheWriteTokens: 200, toolCalls: 15, retries: 0, pullRequest: { state: 'closed', rework: 0 } },
];

test('given two cohorts of dispatched workloads, when the insights page is requested, then each cohort row shows its figures', async () => {
  const rows = rowsOf(await dashboard(COHORT_SEEDS).page());

  assert.deepEqual(rows.get(fingerprintHash(SONNET)), {
    label: 'sonnet-5.5 · high · prompt#3fa2',
    workloads: '4',
    opened: '75.0%',
    merged: '50.0%',
    'cost-median': '$0.250000',
    'cost-p90': '$0.370000',
    'cost-per-merged': '$0.500000',
    duration: '2m 30s',
    'cache-hit': '75.0%',
    'tool-calls': '25',
    retries: '1',
    rework: '2',
  });
  assert.deepEqual(rows.get(fingerprintHash(GLM)), {
    label: 'glm-5 · default · prompt#9b1e',
    workloads: '2',
    opened: '100.0%',
    merged: '50.0%',
    'cost-median': '$0.400000',
    'cost-p90': '$0.480000',
    'cost-per-merged': '$0.800000',
    duration: '3m 20s',
    'cache-hit': '0.0%',
    'tool-calls': '10',
    retries: '0',
    rework: '0',
  });
});

const MANUAL_SEEDS: Seed[] = [
  { id: 'd1', fingerprint: SONNET, seconds: 60, cost: 0.1, toolCalls: 10, retries: 0, pullRequest: { state: 'merged', rework: 0 } },
  { id: 'd2', fingerprint: SONNET, seconds: 60, cost: 0.2, toolCalls: 20, retries: 0 },
  { id: 'm1', fingerprint: SONNET, dispatched: false, seconds: 60, cost: 0.6, toolCalls: 60, retries: 0 },
];

test('given a manual workload in a cohort, when the insights page is requested without and then with the manual filter, then it is absent by default and counts only towards efficiency figures with it', async () => {
  const { page } = dashboard(MANUAL_SEEDS);
  const hash = fingerprintHash(SONNET);

  const without = rowsOf(await page()).get(hash)!;
  assert.equal(without['workloads'], '2');
  assert.equal(without['cost-median'], '$0.150000');
  assert.equal(without['tool-calls'], '15');

  const withManual = rowsOf(await page('?manual=1')).get(hash)!;
  assert.equal(withManual['workloads'], '3');
  assert.equal(withManual['cost-median'], '$0.200000');
  assert.equal(withManual['tool-calls'], '20');
  assert.equal(withManual['opened'], '50.0%');
  assert.equal(withManual['merged'], '50.0%');
  assert.equal(withManual['cost-per-merged'], '$0.300000');
});

test('given workloads recorded without a fingerprint, when the insights page is requested, then they appear together as the unknown-config cohort', async () => {
  const rows = rowsOf(
    await dashboard([
      { id: 'u1', seconds: 60, cost: 0.1, toolCalls: 1, retries: 0 },
      { id: 'u2', seconds: 60, cost: 0.2, toolCalls: 1, retries: 0 },
      { id: 'k1', fingerprint: SONNET, seconds: 60, cost: 0.3, toolCalls: 1, retries: 0 },
    ]).page(),
  );

  assert.equal(rows.size, 2);
  assert.equal(rows.get('')!['label'], 'unknown config');
  assert.equal(rows.get('')!['workloads'], '2');
});

const FILTER_SEEDS: Seed[] = [
  { id: 'f1', fingerprint: SONNET, worker: 'builder', repository: 'forge', start: '2026-09-14T10:00:00.000Z', seconds: 60, cost: 0.1, toolCalls: 1, retries: 0 },
  { id: 'f2', fingerprint: SONNET, worker: 'builder', repository: 'forge', start: '2026-09-21T10:00:00.000Z', seconds: 60, cost: 0.2, toolCalls: 1, retries: 0 },
  { id: 'f3', fingerprint: SONNET, worker: 'refiner', repository: 'forge', start: '2026-09-21T10:00:00.000Z', seconds: 60, cost: 0.3, toolCalls: 1, retries: 0 },
  { id: 'f4', fingerprint: SONNET, worker: 'builder', repository: 'site', start: '2026-09-21T10:00:00.000Z', seconds: 60, cost: 0.4, toolCalls: 1, retries: 0 },
];

const selected = (page: string, name: string): string | undefined => {
  const control = page.match(new RegExp(`<(?:select|input)[^>]*\\sname="${name}"[\\s\\S]*?(?=</select>|/>)`))?.[0] ?? '';
  return control.match(/<option[^>]*\sselected[^>]*value="([^"]*)"|<option[^>]*value="([^"]*)"[^>]*\sselected/)?.slice(1).find(Boolean)
    ?? control.match(/\svalue="([^"]*)"/)?.[1];
};

test('given workloads across workers, repositories and weeks, when the insights page is requested with filters in the query string, then only matching workloads count and the filters show as selected', async () => {
  const { page } = dashboard(FILTER_SEEDS);
  const hash = fingerprintHash(SONNET);

  const everything = await page();
  assert.equal(rowsOf(everything).get(hash)!['workloads'], '4');

  const filtered = await page('?worker=builder&repository=forge&from=2026-09-20&to=2026-09-27');
  assert.equal(rowsOf(filtered).get(hash)!['workloads'], '1');
  assert.equal(rowsOf(filtered).get(hash)!['cost-median'], '$0.200000');
  assert.equal(selected(filtered, 'worker'), 'builder');
  assert.equal(selected(filtered, 'repository'), 'forge');
  assert.equal(selected(filtered, 'from'), '2026-09-20');
  assert.equal(selected(filtered, 'to'), '2026-09-27');
});

test('given cohorts of different sizes recorded in any order, when the insights page is requested, then rows run from the largest cohort to the smallest with the unknown-config cohort last', async () => {
  const quick = { seconds: 60, cost: 0.1, toolCalls: 1, retries: 0 };
  const rows = rowsOf(
    await dashboard([
      { id: 'u1', ...quick },
      { id: 'u2', ...quick },
      { id: 'u3', ...quick },
      { id: 'g1', fingerprint: GLM, ...quick },
      { id: 'g2', fingerprint: GLM, ...quick },
      { id: 's1', fingerprint: SONNET, ...quick },
      { id: 's2', fingerprint: SONNET, ...quick },
      { id: 's3', fingerprint: SONNET, ...quick },
      { id: 's4', fingerprint: SONNET, ...quick },
    ]).page(),
  );

  assert.deepEqual([...rows.keys()], [fingerprintHash(SONNET), fingerprintHash(GLM), '']);
});

const SUBSCRIBED: ConfigFingerprint = { ...SONNET, provider: 'anthropic' };

const MIXED_SEEDS: Seed[] = [
  { id: 'o1', fingerprint: SONNET, seconds: 60, cost: 0.2, toolCalls: 1, retries: 0, pullRequest: { state: 'merged', rework: 0 } },
  { id: 'o2', fingerprint: SONNET, seconds: 60, cost: 0.4, toolCalls: 1, retries: 0, pullRequest: { state: 'merged', rework: 0 } },
  { id: 's1', fingerprint: SUBSCRIBED, seconds: 60, cost: 0, listPrice: 3, toolCalls: 1, retries: 0, pullRequest: { state: 'merged', rework: 0 } },
  { id: 's2', fingerprint: SUBSCRIBED, seconds: 60, cost: 0, listPrice: 5, toolCalls: 1, retries: 0 },
];

test('given an OpenRouter cohort and a subscription cohort of the same worker, when the insights page is requested, then the subscription cohort\'s costs are its list-price equivalents, marked as such, and the OpenRouter cohort\'s are its billed costs alone', async () => {
  const page = await dashboard(MIXED_SEEDS).page();
  const rows = rowsOf(page);
  const basis = (hash: string): string =>
    page.match(new RegExp(`<tr[^>]*\\sdata-cohort="${hash}"[^>]*\\sdata-cost-basis="([^"]*)"`))?.[1] ?? 'missing';

  const billed = rows.get(fingerprintHash(SONNET))!;
  const subscription = rows.get(fingerprintHash(SUBSCRIBED))!;
  assert.deepEqual(
    [billed['cost-median'], billed['cost-p90'], billed['cost-per-merged']],
    ['$0.300000', '$0.380000', '$0.300000'],
  );
  assert.deepEqual(
    [subscription['cost-median'], subscription['cost-p90'], subscription['cost-per-merged']],
    ['$4.000000', '$4.800000', '$8.000000'],
  );
  assert.equal(basis(fingerprintHash(SONNET)), 'billed');
  assert.equal(basis(fingerprintHash(SUBSCRIBED)), 'list-price');
  assert.match(subscription.label!, /subscription/);
  assert.doesNotMatch(billed.label!, /subscription/);
  assert.match(page, /<th[^>]*>Median cost<\/th>/);
  assert.match(page, /data-cost-note[^>]*>[^<]*list-price equivalent[^<]*not billed/i);
});

test('given only OpenRouter cohorts, when the insights page is requested, then the page carries no list-price note', async () => {
  const page = await dashboard(COHORT_SEEDS).page();

  assert.doesNotMatch(page, /data-cost-note|data-cost-basis="list-price"/);
});

test('given a subscription cohort with one priced and one unpriced workload, and another whose workloads are all unpriced, when the insights page is requested, then unpriced workloads count but add no cost, and a cohort with nothing priced shows n/a', async () => {
  const unpriced: ConfigFingerprint = { ...SONNET, provider: 'anthropic', promptTemplate: 'aaaa1111' };
  const page = await dashboard([
    ...MIXED_SEEDS,
    { id: 'u1', fingerprint: unpriced, seconds: 60, cost: 0, listPrice: null, toolCalls: 1, retries: 0 },
    { id: 'p1', fingerprint: SUBSCRIBED, seconds: 60, cost: 0, listPrice: null, toolCalls: 1, retries: 0 },
  ]).page();
  const rows = rowsOf(page);

  const partly = rows.get(fingerprintHash(SUBSCRIBED))!;
  assert.deepEqual([partly.workloads, partly['cost-median'], partly['cost-p90']], ['3', '$4.000000', '$4.800000']);
  const none = rows.get(fingerprintHash(unpriced))!;
  assert.deepEqual([none.workloads, none['cost-median'], none['cost-p90'], none['cost-per-merged']], ['1', 'n/a', 'n/a', 'n/a']);
});
