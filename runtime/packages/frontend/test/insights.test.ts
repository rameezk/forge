import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintHash } from '@forge/shared';
import type { ConfigFingerprint } from '@forge/shared';
import { textOf } from './html.ts';
import { dashboard, GLM, onCostTab, SONNET, type Seed } from './insights-seed.ts';

type Row = Record<string, string>;

const rowsOf = (page: string): Map<string, Row> =>
  new Map(
    [...page.matchAll(/<tr[^>]*\sdata-cohort="([^"]*)"[^>]*>([\s\S]*?)<\/tr>/g)].map(([, key, body]) => [
      key!,
      Object.fromEntries(
        [...body!.matchAll(/<td[^>]*\sdata-metric="([^"]+)"[^>]*>([\s\S]*?)<\/td>/g)].map(([, name, cell]) => [
          name!,
          textOf(cell!.replace(/<p[^>]*data-owner[^>]*>[\s\S]*?<\/p>/, '')),
        ]),
      ),
    ]),
  );

const rowHtml = (page: string, hash: string): string =>
  page.match(new RegExp(`<tr[^>]*\\sdata-cohort="${hash}"[^>]*>[\\s\\S]*?</tr>`))?.[0] ?? 'missing';

const ownerLine = (page: string, hash: string): string | undefined => {
  const line = rowHtml(page, hash).match(/<p[^>]*data-owner[^>]*>([\s\S]*?)<\/p>/)?.[1];
  return line === undefined ? undefined : textOf(line);
};

const groupOf = (page: string, hash: string): string | undefined =>
  [...page.matchAll(/<tbody[^>]*\sdata-cohort-group="([^"]+)"[^>]*>([\s\S]*?)<\/tbody>/g)].find(([, , body]) =>
    body!.includes(`data-cohort="${hash}"`),
  )?.[1];

const groupHeader = (page: string, group: string): string | undefined => {
  const body = page.match(new RegExp(`<tbody[^>]*\\sdata-cohort-group="${group}"[^>]*>([\\s\\S]*?)</tbody>`))?.[1];
  const header = body?.match(/<tr[^>]*data-group-header[^>]*>([\s\S]*?)<\/tr>/)?.[1];
  return header === undefined ? undefined : textOf(header.replace(/<span[^>]*aria-hidden[^>]*>[\s\S]*?<\/span>/, ''));
};

const cellTitle = (page: string, hash: string, metric: string): string | undefined =>
  rowHtml(page, hash).match(new RegExp(`<td[^>]*\\sdata-metric="${metric}"[^>]*\\stitle="([^"]*)"`))?.[1];

type PageOf = (query?: string) => Promise<string>;

const acrossTabs = async (page: PageOf, query = ''): Promise<Map<string, Row>> => {
  const delivery = rowsOf(await page(query));
  const cost = rowsOf(await page(onCostTab(query)));
  return new Map([...delivery].map(([hash, row]) => [hash, { ...row, ...cost.get(hash) }]));
};

const COHORT_SEEDS: Seed[] = [
  { id: 'a1', fingerprint: SONNET, seconds: 60, cost: 0.1, cacheReadTokens: 300, toolCalls: 10, retries: 0, pullRequest: { state: 'merged', rework: 1 } },
  { id: 'a2', fingerprint: SONNET, seconds: 120, cost: 0.2, cacheReadTokens: 300, toolCalls: 20, retries: 1, pullRequest: { state: 'merged', rework: 3 } },
  { id: 'a3', fingerprint: SONNET, seconds: 180, cost: 0.3, cacheReadTokens: 300, toolCalls: 30, retries: 1, pullRequest: { state: 'open', rework: 0 } },
  { id: 'a4', fingerprint: SONNET, seconds: 240, cost: 0.4, cacheReadTokens: 300, toolCalls: 40, retries: 2 },
  { id: 'b1', fingerprint: GLM, seconds: 300, cost: 0.5, inputTokens: 200, cacheWriteTokens: 200, toolCalls: 5, retries: 0, pullRequest: { state: 'merged', rework: 0 } },
  { id: 'b2', fingerprint: GLM, seconds: 100, cost: 0.3, inputTokens: 200, cacheWriteTokens: 200, toolCalls: 15, retries: 0, pullRequest: { state: 'closed', rework: 0 } },
];

test('given two cohorts of dispatched workloads, when the insights page is requested, then each cohort row shows its figures', async () => {
  const rows = await acrossTabs(dashboard(COHORT_SEEDS).page);

  assert.deepEqual(rows.get(fingerprintHash(SONNET)), {
    'first-run': '2026-09-21 10:00',
    'last-run': '2026-09-21 10:00',
    label: `pi · sonnet-5.5 · high · prompt#3fa2 · ${fingerprintHash(SONNET).slice(0, 8)}`,
    workloads: '4',
    done: '75.0%',
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
    'first-run': '2026-09-21 10:00',
    'last-run': '2026-09-21 10:00',
    label: `pi · glm-5 · default · prompt#9b1e · ${fingerprintHash(GLM).slice(0, 8)}`,
    workloads: '2',
    done: '100.0%',
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

const CLAUDE_CODE: ConfigFingerprint = { ...SONNET, harness: 'claude-code', provider: 'anthropic', harnessVersion: '2.0.0' };
const CLAUDE_CODE_UPGRADED: ConfigFingerprint = { ...CLAUDE_CODE, harnessVersion: '2.1.0' };

test('given a Claude Code cohort and a cohort recording no harness, when the insights page is requested, then their labels lead with the harness and end with the cohort hash', async () => {
  const rows = rowsOf(await dashboard([
    { id: 'a1', fingerprint: CLAUDE_CODE, seconds: 60, cost: 0.1, toolCalls: 1, retries: 0 },
    { id: 'b1', fingerprint: SONNET, seconds: 60, cost: 0.1, toolCalls: 1, retries: 0 },
  ]).page());

    assert.match(rows.get(fingerprintHash(CLAUDE_CODE))!['label']!, new RegExp(`^claude-code · sonnet-5\\.5 · high · prompt#3fa2 · ${fingerprintHash(CLAUDE_CODE).slice(0, 8)}$`));
  assert.match(rows.get(fingerprintHash(SONNET))!['label']!, new RegExp(`^pi · sonnet-5\\.5 · high · prompt#3fa2 · ${fingerprintHash(SONNET).slice(0, 8)}$`));
});

test('given two cohorts differing only in harness version, when the insights page is requested, then their labels differ only in the trailing hash', async () => {
  const rows = rowsOf(await dashboard([
    { id: 'a1', fingerprint: CLAUDE_CODE, seconds: 60, cost: 0.1, toolCalls: 1, retries: 0 },
    { id: 'a2', fingerprint: CLAUDE_CODE_UPGRADED, seconds: 60, cost: 0.1, toolCalls: 1, retries: 0 },
  ]).page());

  const [older, newer] = [CLAUDE_CODE, CLAUDE_CODE_UPGRADED].map((f) => rows.get(fingerprintHash(f))!['label']!);
  assert.notEqual(older, newer);
  assert.equal(older!.replace(/ · [0-9a-f]{8}$/, ''), newer!.replace(/ · [0-9a-f]{8}$/, ''));
});

const MANUAL_SEEDS: Seed[] = [
  { id: 'd1', fingerprint: SONNET, seconds: 60, cost: 0.1, toolCalls: 10, retries: 0, pullRequest: { state: 'merged', rework: 0 } },
  { id: 'd2', fingerprint: SONNET, seconds: 60, cost: 0.2, toolCalls: 20, retries: 0 },
  { id: 'm1', fingerprint: SONNET, dispatched: false, seconds: 60, cost: 0.6, toolCalls: 60, retries: 0 },
];

test('given a manual workload in a cohort, when the insights page is requested without and then with the manual filter, then it is absent by default and counts only towards efficiency figures with it', async () => {
  const { page } = dashboard(MANUAL_SEEDS);
  const hash = fingerprintHash(SONNET);

  const without = (await acrossTabs(page)).get(hash)!;
  assert.equal(without['workloads'], '2');
  assert.equal(without['cost-median'], '$0.150000');
  assert.equal(without['tool-calls'], '15');

  const withManual = (await acrossTabs(page, '?manual=1')).get(hash)!;
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

  const query = '?worker=builder&repository=forge&from=2026-09-20&to=2026-09-27';
  const filtered = await page(query);
  assert.equal(rowsOf(filtered).get(hash)!['workloads'], '1');
  assert.equal(rowsOf(await page(onCostTab(query))).get(hash)!['cost-median'], '$0.200000');
  assert.equal(selected(filtered, 'worker'), 'builder');
  assert.equal(selected(filtered, 'repository'), 'forge');
  assert.equal(selected(filtered, 'from'), '2026-09-20');
  assert.equal(selected(filtered, 'to'), '2026-09-27');
});

const SUBSCRIBED: ConfigFingerprint = { ...SONNET, provider: 'anthropic' };

const MIXED_SEEDS: Seed[] = [
  { id: 'o1', fingerprint: SONNET, seconds: 60, cost: 0.2, toolCalls: 1, retries: 0, pullRequest: { state: 'merged', rework: 0 } },
  { id: 'o2', fingerprint: SONNET, seconds: 60, cost: 0.4, toolCalls: 1, retries: 0, pullRequest: { state: 'merged', rework: 0 } },
  { id: 's1', fingerprint: SUBSCRIBED, seconds: 60, cost: 0, listPrice: 3, toolCalls: 1, retries: 0, pullRequest: { state: 'merged', rework: 0 } },
  { id: 's2', fingerprint: SUBSCRIBED, seconds: 60, cost: 0, listPrice: 5, toolCalls: 1, retries: 0 },
];

test('given an OpenRouter cohort and a subscription cohort of the same worker, when the insights page is requested, then the subscription cohort\'s costs are its list-price equivalents, marked as such, and the OpenRouter cohort\'s are its billed costs alone', async () => {
  const page = await dashboard(MIXED_SEEDS).page('?tab=cost');
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
  const page = await dashboard(COHORT_SEEDS).page('?tab=cost');

  assert.doesNotMatch(page, /data-cost-note|data-cost-basis="list-price"/);
});

test('given a subscription cohort with one priced and one unpriced workload, and another whose workloads are all unpriced, when the insights page is requested, then unpriced workloads count but add no cost, and a cohort with nothing priced shows n/a', async () => {
  const unpriced: ConfigFingerprint = { ...SONNET, provider: 'anthropic', promptTemplate: 'aaaa1111' };
  const page = await dashboard([
    ...MIXED_SEEDS,
    { id: 'u1', fingerprint: unpriced, seconds: 60, cost: 0, listPrice: null, toolCalls: 1, retries: 0 },
    { id: 'p1', fingerprint: SUBSCRIBED, seconds: 60, cost: 0, listPrice: null, toolCalls: 1, retries: 0 },
  ]).page('?tab=cost');
  const rows = rowsOf(page);

  const partly = rows.get(fingerprintHash(SUBSCRIBED))!;
  assert.deepEqual([partly.workloads, partly['cost-median'], partly['cost-p90']], ['3', '$4.000000', '$4.800000']);
  const none = rows.get(fingerprintHash(unpriced))!;
  assert.deepEqual([none.workloads, none['cost-median'], none['cost-p90'], none['cost-per-merged']], ['1', 'n/a', 'n/a', 'n/a']);
});

test('given a subscription cohort where one merged workload has a generation the catalog could not price, when the insights page is requested, then that workload adds no cost and cost per merged PR reads n/a instead of an understated figure', async () => {
  const page = await dashboard([
    { id: 'a1', fingerprint: SUBSCRIBED, seconds: 60, cost: 0, listPrice: 3, toolCalls: 1, retries: 0, pullRequest: { state: 'merged', rework: 0 } },
    { id: 'a2', fingerprint: SUBSCRIBED, seconds: 60, cost: 0, listPrice: 5, unpricedGeneration: true, toolCalls: 1, retries: 0, pullRequest: { state: 'merged', rework: 0 } },
  ]).page('?tab=cost');

  const row = rowsOf(page).get(fingerprintHash(SUBSCRIBED))!;
  assert.deepEqual([row['cost-median'], row['cost-per-merged']], ['$3.000000', 'n/a']);
});

const UNCONFIRMED_SEEDS: Seed[] = [
  { id: 'c1', fingerprint: SONNET, seconds: 60, cost: 0.1, toolCalls: 1, retries: 0, pullRequest: { state: 'merged', rework: 0 } },
  { id: 'c2', fingerprint: SONNET, seconds: 60, cost: 0, unconfirmedEstimate: 0.36, toolCalls: 1, retries: 0 },
];

test('given a cohort with a workload billing could not confirm, when the insights page is requested, then the cohort counts that workload\'s unconfirmed estimate', async () => {
  const rows = rowsOf(await dashboard(UNCONFIRMED_SEEDS).page('?tab=cost'));

  assert.equal(rows.get(fingerprintHash(SONNET))?.['cost-median'], '$0.230000');
  assert.equal(rows.get(fingerprintHash(SONNET))?.['cost-per-merged'], '$0.460000');
});

const quick = { seconds: 60, cost: 0.1, toolCalls: 1, retries: 0 };
const HASH = { sonnet: fingerprintHash(SONNET), glm: fingerprintHash(GLM) };
const THIRD: ConfigFingerprint = { ...SONNET, promptTemplate: 'c3c3c3c3' };
const FOURTH: ConfigFingerprint = { ...SONNET, promptTemplate: 'd4d4d4d4' };

test('given a worker whose latest workload on one repository is in cohort B and on another in cohort A, when the insights page is requested, then both cohorts are active and each row names its own repository', async () => {
  const page = await dashboard([
    { id: 'p1', fingerprint: SONNET, repository: 'forge', start: '2026-09-01T10:00:00.000Z', ...quick },
    { id: 'p2', fingerprint: GLM, repository: 'forge', start: '2026-09-10T10:00:00.000Z', ...quick },
    { id: 'p3', fingerprint: SONNET, repository: 'site', start: '2026-09-05T10:00:00.000Z', ...quick },
  ]).page();

  assert.equal(ownerLine(page, HASH.sonnet), 'Active for builder on site');
  assert.equal(ownerLine(page, HASH.glm), 'Active for builder on forge');
});

test('given workers active in one cohort on several repositories, when the insights page is requested, then the row lists every worker and repository pair', async () => {
  const page = await dashboard([
    { id: 'p1', fingerprint: SONNET, worker: 'refiner', repository: 'forge', start: '2026-09-01T10:00:00.000Z', ...quick },
    { id: 'p2', fingerprint: SONNET, worker: 'refiner', repository: 'dotfiles', start: '2026-09-02T10:00:00.000Z', ...quick },
    { id: 'p3', fingerprint: SONNET, worker: 'builder', repository: 'forge', start: '2026-09-03T10:00:00.000Z', ...quick },
  ]).page();

  assert.equal(ownerLine(page, HASH.sonnet), 'Active for builder on forge; refiner on dotfiles and forge');
});

test('given a pair whose latest workload moved from cohort A to cohort B, when the insights page is requested, then only B is active', async () => {
  const page = await dashboard([
    { id: 'p1', fingerprint: SONNET, start: '2026-09-01T10:00:00.000Z', ...quick },
    { id: 'p2', fingerprint: GLM, start: '2026-09-10T10:00:00.000Z', ...quick },
  ]).page();

  assert.equal(ownerLine(page, HASH.sonnet), 'Ran for builder on forge');
  assert.equal(ownerLine(page, HASH.glm), 'Active for builder on forge');
});

test('given a manual workload and a running workload after the latest finished dispatched one, when the insights page is requested with manual workloads included, then neither decides what is active nor shows in Last run', async () => {
  const page = await dashboard([
    { id: 'p0', fingerprint: GLM, start: '2026-09-02T10:00:00.000Z', ...quick },
    { id: 'p1', fingerprint: SONNET, start: '2026-09-10T10:00:00.000Z', ...quick },
    { id: 'p2', fingerprint: GLM, dispatched: false, start: '2026-09-12T10:00:00.000Z', ...quick },
    { id: 'p3', fingerprint: THIRD, running: true, start: '2026-09-13T10:00:00.000Z', ...quick },
  ]).page('?manual=1');
  const rows = rowsOf(page);

  assert.equal(ownerLine(page, HASH.sonnet), 'Active for builder on forge');
  assert.equal(ownerLine(page, HASH.glm), 'Ran for builder on forge');
  assert.equal(rows.get(HASH.glm)!['last-run'], '2026-09-02 10:00');
  assert.equal(rows.get(HASH.glm)!['workloads'], '2');
  assert.equal(rows.has(fingerprintHash(THIRD)), false);
});

test('given finished dispatched workloads and a display time zone other than UTC, when the insights page is requested, then First run and Last run show the start times in that zone to the minute with the full timestamps on hover', async () => {
  const page = await dashboard(
    [
      { id: 'p1', fingerprint: SONNET, start: '2026-10-21T12:32:10.000Z', ...quick },
      { id: 'p2', fingerprint: SONNET, start: '2026-10-25T08:05:30.000Z', ...quick },
    ],
    'Africa/Johannesburg',
  ).page();
  const row = rowsOf(page).get(HASH.sonnet)!;

  assert.deepEqual([row['first-run'], row['last-run']], ['2026-10-21 14:32', '2026-10-25 10:05']);
  assert.equal(cellTitle(page, HASH.sonnet, 'first-run'), '2026-10-21 14:32:10');
  assert.equal(cellTitle(page, HASH.sonnet, 'last-run'), '2026-10-25 10:05:30');
  assert.match(page, /<th[^>]*>First run<\/th>\s*<th[^>]*>Last run<\/th>/);
});

test('given a cohort with workloads inside and outside a window on two repositories, when the insights page is requested filtered to one repository and that window, then metrics count only matches while First run, Last run and active match the unfiltered page', async () => {
  const { page } = dashboard([
    { id: 'p1', fingerprint: SONNET, repository: 'forge', start: '2026-09-14T10:00:00.000Z', ...quick },
    { id: 'p2', fingerprint: SONNET, repository: 'forge', start: '2026-09-21T10:00:00.000Z', ...quick },
    { id: 'p3', fingerprint: SONNET, repository: 'site', start: '2026-09-28T10:00:00.000Z', ...quick },
  ]);

  const everything = await page();
  const filtered = await page('?repository=forge&from=2026-09-20&to=2026-09-27');
  const [all, some] = [everything, filtered].map((html) => rowsOf(html).get(HASH.sonnet)!);

  assert.equal(all!['workloads'], '3');
  assert.equal(some!['workloads'], '1');
  assert.deepEqual([some!['first-run'], some!['last-run']], [all!['first-run'], all!['last-run']]);
  assert.deepEqual([all!['first-run'], all!['last-run']], ['2026-09-14 10:00', '2026-09-28 10:00']);
  assert.equal(ownerLine(filtered, HASH.sonnet), 'Active for builder on forge and site');
  assert.equal(ownerLine(filtered, HASH.sonnet), ownerLine(everything, HASH.sonnet));
});

test('given a large inactive cohort, a small active one, two others and the unknown-config cohort, when the insights page is requested, then active comes first, then Last run newest first, then unknown-config', async () => {
  const rows = rowsOf(
    await dashboard([
      { id: 'u1', start: '2026-09-12T10:00:00.000Z', ...quick },
      { id: 'l1', fingerprint: FOURTH, start: '2026-09-01T10:00:00.000Z', ...quick },
      { id: 'l2', fingerprint: FOURTH, start: '2026-09-02T10:00:00.000Z', ...quick },
      { id: 'l3', fingerprint: FOURTH, start: '2026-09-03T10:00:00.000Z', ...quick },
      { id: 'o1', fingerprint: THIRD, start: '2026-09-05T10:00:00.000Z', ...quick },
      { id: 'o2', fingerprint: GLM, start: '2026-09-07T10:00:00.000Z', ...quick },
      { id: 's1', fingerprint: SONNET, start: '2026-09-09T10:00:00.000Z', ...quick },
    ]).page(),
  );

  assert.deepEqual([...rows.keys()], [HASH.sonnet, HASH.glm, fingerprintHash(THIRD), fingerprintHash(FOURTH), '']);
});

test('given workloads recorded without a fingerprint that are the latest for their pair, when the insights page is requested, then the unknown-config cohort shows First run and Last run, is not active and stays last', async () => {
  const page = await dashboard([
    { id: 'k1', fingerprint: SONNET, start: '2026-09-01T10:00:00.000Z', ...quick },
    { id: 'u1', start: '2026-09-10T10:00:00.000Z', ...quick },
    { id: 'u2', start: '2026-09-11T10:00:00.000Z', ...quick },
  ]).page();
  const rows = rowsOf(page);

  assert.deepEqual([...rows.keys()], [HASH.sonnet, '']);
  assert.deepEqual([rows.get('')!['first-run'], rows.get('')!['last-run']], ['2026-09-10 10:00', '2026-09-11 10:00']);
  assert.equal(groupOf(page, ''), 'previous');
  assert.equal(groupOf(page, HASH.sonnet), 'previous');
  assert.equal(ownerLine(page, ''), 'Ran for builder on forge');
});

test('given cohorts active for some pairs, cohorts active for none and the unknown-config cohort, when the insights page is requested, then active cohorts sit under Active cohorts and the rest under a collapsed Previous cohorts header with their count and last run', async () => {
  const page = await dashboard([
    { id: 'u1', start: '2026-09-12T10:00:00.000Z', ...quick },
    { id: 'l1', fingerprint: FOURTH, start: '2026-09-01T10:00:00.000Z', ...quick },
    { id: 'o1', fingerprint: THIRD, start: '2026-09-05T10:00:00.000Z', ...quick },
    { id: 's1', fingerprint: SONNET, repository: 'site', start: '2026-09-09T10:00:00.000Z', ...quick },
  ]).page();

  assert.equal(groupOf(page, HASH.sonnet), 'active');
  assert.deepEqual([fingerprintHash(THIRD), fingerprintHash(FOURTH), ''].map((hash) => groupOf(page, hash)), ['previous', 'previous', 'previous']);
  assert.match(groupHeader(page, 'active')!, /^Active cohorts/);
  assert.match(groupHeader(page, 'previous')!, /^Previous cohorts\s*3\s*last run 2026-09-12 10:00$/i);
  assert.match(page, /<tbody[^>]*\sdata-cohort-group="previous"[^>]*\sdata-collapsed/);
  assert.doesNotMatch(page, /<tbody[^>]*\sdata-cohort-group="active"[^>]*\sdata-collapsed/);
});

test('given an active cohort for one worker on two repositories and a previous cohort that ran for another worker on one, when the insights page is requested, then each row says who it belongs to and none carries an active badge', async () => {
  const page = await dashboard([
    { id: 'p1', fingerprint: SONNET, worker: 'builder', repository: 'forge', start: '2026-09-09T10:00:00.000Z', ...quick },
    { id: 'p2', fingerprint: SONNET, worker: 'builder', repository: 'site', start: '2026-09-10T10:00:00.000Z', ...quick },
    { id: 'p3', fingerprint: GLM, worker: 'refiner', repository: 'forge', start: '2026-09-01T10:00:00.000Z', ...quick },
    { id: 'p4', fingerprint: THIRD, worker: 'refiner', repository: 'forge', start: '2026-09-11T10:00:00.000Z', ...quick },
  ]).page();

  assert.equal(ownerLine(page, HASH.sonnet), 'Active for builder on forge and site');
  assert.equal(ownerLine(page, HASH.glm), 'Ran for refiner on forge');
  assert.doesNotMatch(page, /data-badge="active"/);
});

const REVISER = { worker: 'reviser' };

test('given a worker that finished one revision and failed another on a repository and never dispatched there, when the insights page is requested with Kind Revision, then its revision cohort is active for it with Done at 50% and the dispatch-only figures n/a', async () => {
  const { page } = dashboard([
    { id: 'v1', fingerprint: GLM, kind: 'revision', start: '2026-09-10T10:00:00.000Z', ...REVISER, ...quick },
    { id: 'v2', fingerprint: GLM, kind: 'revision', failed: true, start: '2026-09-11T10:00:00.000Z', ...REVISER, ...quick },
  ]);
  const delivery = await page('?kind=revision');
  const row = (await acrossTabs(page, '?kind=revision')).get(HASH.glm)!;

  assert.equal(groupOf(delivery, HASH.glm), 'active');
  assert.equal(ownerLine(delivery, HASH.glm), 'Active for reviser on forge');
  assert.equal(row['workloads'], '2');
  assert.equal(row['done'], '50.0%');
  assert.equal(row['opened'], 'n/a');
  assert.equal(row['merged'], 'n/a');
  assert.equal(row['rework'], 'n/a');
  assert.equal(row['cost-per-merged'], 'n/a');
});

const KINDS: Seed[] = [
  { id: 'k1', fingerprint: SONNET, start: '2026-09-10T10:00:00.000Z', ...quick },
  { id: 'k2', fingerprint: GLM, kind: 'revision', worker: 'reviser', start: '2026-09-11T10:00:00.000Z', ...quick },
  { id: 'k3', fingerprint: THIRD, kind: 'conflict-resolution', worker: 'resolver', start: '2026-09-12T10:00:00.000Z', ...quick },
  { id: 'k4', fingerprint: FOURTH, dispatched: false, worker: 'manual', start: '2026-09-13T10:00:00.000Z', ...quick },
];

const selectedKind = (page: string): string | undefined =>
  page.match(/<select name="kind"[\s\S]*?<option value="([^"]*)" selected/)?.[1];

test('given dispatches, revisions and conflict resolutions, when the insights page is requested with no Kind, then Kind is Dispatch and only dispatch cohorts are listed', async () => {
  const page = await dashboard(KINDS).page();

  assert.equal(selectedKind(page), 'dispatch');
  assert.deepEqual([...rowsOf(page).keys()], [HASH.sonnet]);
});

test('given a dispatch, a revision, a conflict resolution and a manual workload, when the insights page is requested with Kind All, then manual workloads count only when ticked', async () => {
  const { page } = dashboard(KINDS);

  const without = await page('?kind=all');
  assert.equal(selectedKind(without), 'all');
  assert.deepEqual(new Set(rowsOf(without).keys()), new Set([HASH.sonnet, HASH.glm, fingerprintHash(THIRD)]));

  const withManual = await page('?kind=all&manual=1');
  assert.deepEqual(new Set(rowsOf(withManual).keys()), new Set([HASH.sonnet, HASH.glm, fingerprintHash(THIRD), fingerprintHash(FOURTH)]));
});

test('given a dispatch and a revision in one date range, when the insights page is requested with Kind All and then Kind Dispatch, then the cost chart plots both and then only the dispatch', async () => {
  const { page } = dashboard(KINDS);
  const plotted = (html: string): string[] => [...html.matchAll(/data-point data-run="([^"]*)"/g)].map(([, run]) => run!);

  assert.deepEqual(plotted(await page('?kind=all&tab=cost')), ['k1', 'k2', 'k3']);
  assert.deepEqual(plotted(await page('?kind=dispatch&tab=cost')), ['k1']);
  assert.deepEqual(plotted(await page('?kind=conflict-resolution&tab=cost')), ['k3']);
});

test('given a conflict resolution cohort, when the insights page is requested with Kind Conflict resolution or an unknown Kind, then the cohort is active for its resolver and an unknown Kind falls back to Dispatch', async () => {
  const { page } = dashboard(KINDS);

  const resolutions = await page('?kind=conflict-resolution');
  assert.equal(ownerLine(resolutions, fingerprintHash(THIRD)), 'Active for resolver on forge');
  assert.equal(rowsOf(resolutions).get(fingerprintHash(THIRD))!['done'], '100.0%');

  const unknown = await page('?kind=bogus');
  assert.equal(selectedKind(unknown), 'dispatch');
  assert.deepEqual([...rowsOf(unknown).keys()], [HASH.sonnet]);
});

const DELIVERY_METRICS = ['label', 'first-run', 'last-run', 'workloads', 'done', 'opened', 'merged', 'retries', 'rework', 'duration', 'tool-calls'];
const COST_METRICS = ['label', 'workloads', 'cost-median', 'cost-p90', 'cost-per-merged', 'cache-hit'];

const tabsOf = (page: string): { tab: string; selected: boolean; href: string }[] =>
  [...page.matchAll(/<a\s[^>]*data-tab="([^"]+)"[^>]*>/g)].map(([tag, name]) => ({
    tab: name!,
    selected: /aria-current="page"/.test(tag!),
    href: (tag!.match(/href="([^"]*)"/)?.[1] ?? '').replaceAll('&amp;', '&'),
  }));

const metricsOf = (page: string, hash: string): string[] => Object.keys(rowsOf(page).get(hash) ?? {});

test('given cohorts with dispatches and costs, when the insights page is requested with no tab, then Delivery is selected, Kind is Dispatch and the table shows only the Delivery columns', async () => {
  const page = await dashboard(COHORT_SEEDS).page();

  assert.deepEqual(tabsOf(page).map(({ tab, selected }) => [tab, selected]), [['delivery', true], ['cost', false], ['failures', false], ['risk', false]]);
  assert.deepEqual(
    [...page.matchAll(/<a\s[^>]*data-tab="[^"]+"[^>]*>([\s\S]*?)<\/a>/g)].map(([, text]) => textOf(text!)),
    ['Delivery', 'Cost', 'Failures', 'Risk'],
  );
  assert.match(page, /<option value="dispatch" selected>/);
  assert.deepEqual(metricsOf(page, fingerprintHash(SONNET)), DELIVERY_METRICS);
  assert.deepEqual(
    [...page.matchAll(/<th class="[^"]*">([^<]+)<\/th>/g)].map(([, text]) => text),
    ['Cohort', 'First run', 'Last run', 'Workloads', 'Done', 'Opened', 'Merged', 'Retries per workload', 'Rework per merged PR', 'Median duration', 'Median tool calls'],
  );
  assert.doesNotMatch(page, /data-cost-chart|data-provider-shares|data-cost-note/);
});

test('given the same cohorts, when the Cost tab is requested, then the chart comes first, the table shows only the Cost columns and Provider share follows', async () => {
  const page = await dashboard(COHORT_SEEDS).page('?tab=cost');

  assert.deepEqual(tabsOf(page).map(({ tab, selected }) => [tab, selected]), [['delivery', false], ['cost', true], ['failures', false], ['risk', false]]);
  assert.deepEqual(metricsOf(page, fingerprintHash(SONNET)), COST_METRICS);
  assert.deepEqual(
    [...page.matchAll(/<th class="[^"]*">([^<]+)<\/th>/g)].map(([, text]) => text),
    ['Cohort', 'Workloads', 'Median cost', 'p90 cost', 'Cost per merged PR', 'Cache hit'],
  );
  const at = (marker: string): number => page.indexOf(marker);
  assert.ok(at('data-cost-chart') > 0 && at('data-cost-chart') < at('data-cohorts'), 'chart before table');
  assert.ok(at('data-cohorts') < at('data-provider-shares'), 'provider share after table');
});

test('given a subscription cohort, when the Cost tab and then the Delivery tab are requested, then the list-price note shows only on Cost', async () => {
  const cost = await dashboard(MIXED_SEEDS).page('?tab=cost');
  const delivery = await dashboard(MIXED_SEEDS).page('?tab=delivery');

  assert.match(cost, /data-cost-note/);
  assert.doesNotMatch(delivery, /data-cost-note/);
});

test('given the Cost tab and filters, when the page renders, then the tab links and the filter form carry the filters and the open tab', async () => {
  const page = await dashboard(COHORT_SEEDS).page('?tab=cost&worker=builder&kind=all');

  const [delivery, cost] = tabsOf(page);
  assert.equal(new URL(delivery!.href, 'http://x').searchParams.get('tab'), null);
  assert.equal(new URL(delivery!.href, 'http://x').searchParams.get('worker'), 'builder');
  assert.equal(new URL(cost!.href, 'http://x').searchParams.get('tab'), 'cost');
  assert.equal(new URL(cost!.href, 'http://x').searchParams.get('kind'), 'all');
  assert.match(page, /<input type="hidden" name="tab" value="cost"/);
});

test('given an unknown tab, when the insights page is requested, then Delivery is selected', async () => {
  const page = await dashboard(COHORT_SEEDS).page('?tab=bogus');

  assert.deepEqual(tabsOf(page).map(({ selected }) => selected), [true, false, false, false]);
});

test('given a table wider than the viewport, when the insights page is requested on either tab, then the Cohort column header and cells are pinned to the left edge', async () => {
  for (const query of ['', '?tab=cost', '?tab=failures']) {
    const page = await dashboard(COHORT_SEEDS).page(query);

    assert.match(page, /<th class="[^"]*\bsticky\b[^"]*\bleft-0\b[^"]*">Cohort<\/th>/);
    assert.match(rowHtml(page, fingerprintHash(SONNET)), /<td[^>]*class="[^"]*\bsticky\b[^"]*\bleft-0\b[^"]*"[^>]*data-metric="label"/);
  }
});
