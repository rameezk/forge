import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintHash } from '@forge/shared';
import type { ConfigFingerprint } from '@forge/shared';
import { textOf } from './html.ts';
import { dashboard, GLM, SONNET, type Seed } from './insights-seed.ts';

interface Point {
  cohort: string;
  outcome: string;
  shape: string;
  color: string;
  title: string;
}

const attribute = (tag: string, name: string): string => tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1] ?? '';

const pointsOf = (page: string): Map<string, Point> =>
  new Map(
    [...page.matchAll(/<g\s([^>]*\bdata-point\b[^>]*)>([\s\S]*?)<\/g>/g)].map(([, tag, body]) => [
      attribute(tag!, 'data-run'),
      {
        cohort: attribute(tag!, 'data-cohort'),
        outcome: attribute(tag!, 'data-outcome'),
        shape: attribute(body!.match(/<[a-z]+[^>]*\sdata-shape="[^"]*"[^>]*>/)?.[0] ?? '', 'data-shape'),
        color: attribute(tag!, 'class'),
        title: textOf(body!.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? ''),
      },
    ]),
  );

const CHART_SEEDS: Seed[] = [
  { id: 'a1', fingerprint: SONNET, seconds: 60, cost: 0.3, toolCalls: 1, retries: 0, pullRequest: { state: 'merged', rework: 0 } },
  { id: 'a2', fingerprint: SONNET, seconds: 60, cost: 1.25, toolCalls: 1, retries: 0, pullRequest: { state: 'open', rework: 0 } },
  { id: 'a3', fingerprint: SONNET, seconds: 60, cost: 2, toolCalls: 1, retries: 0 },
  { id: 'b1', fingerprint: GLM, seconds: 60, cost: 0.5, toolCalls: 1, retries: 0, pullRequest: { state: 'merged', rework: 0 } },
  { id: 'b2', fingerprint: GLM, seconds: 60, cost: 0.75, toolCalls: 1, retries: 0 },
];

test('given workloads in two cohorts with merged, opened and failed outcomes, when the insights page is requested, then the chart has one point per workload, coloured by cohort and shaped by outcome, each titled with its workload, cost and outcome', async () => {
  const points = pointsOf(await dashboard(CHART_SEEDS).page());

  assert.deepEqual([...points.keys()].sort(), ['a1', 'a2', 'a3', 'b1', 'b2']);
  const sonnet = fingerprintHash(SONNET);
  const glm = fingerprintHash(GLM);
  assert.deepEqual(
    [...points].map(([id, { cohort, outcome, shape }]) => [id, cohort, outcome, shape]).sort(),
    [
      ['a1', sonnet, 'merged', 'circle'],
      ['a2', sonnet, 'opened', 'diamond'],
      ['a3', sonnet, 'failed', 'cross'],
      ['b1', glm, 'merged', 'circle'],
      ['b2', glm, 'failed', 'cross'],
    ],
  );
  assert.equal(points.get('a1')!.color, points.get('a3')!.color);
  assert.notEqual(points.get('a1')!.color, points.get('b1')!.color);
  assert.equal(points.get('a2')!.title, 'a2 - $1.250000 - opened');
});

const ticksOf = (page: string, axis: string): string[] =>
  [...page.matchAll(new RegExp(`<g\\s[^>]*data-tick="${axis}"[^>]*data-value="([^"]*)"`, 'g'))].map(([, value]) => value!);

const SPAN_SEEDS: Seed[] = [
  { id: 'w1', fingerprint: SONNET, start: '2026-09-14T08:30:00.000Z', seconds: 60, cost: 0.3, toolCalls: 1, retries: 0 },
  { id: 'w2', fingerprint: SONNET, start: '2026-09-20T15:10:00.000Z', seconds: 60, cost: 2.2, toolCalls: 1, retries: 0 },
  { id: 'w3', fingerprint: SONNET, start: '2026-09-27T21:45:00.000Z', seconds: 60, cost: 4.1, toolCalls: 1, retries: 0 },
];

test('given workloads spanning two weeks and costs between $0.30 and $4.10, when the insights page is requested, then the cost ticks are round amounts covering the range and the time ticks fall on day boundaries covering the span', async () => {
  const page = await dashboard(SPAN_SEEDS).page();

  const costs = ticksOf(page, 'cost').map(Number);
  assert.ok(costs.length >= 3);
  assert.ok(costs.every((tick) => tick % 0.5 === 0), `cost ticks ${costs} are not round`);
  assert.ok(Math.min(...costs) <= 0.3 && Math.max(...costs) >= 4.1, `cost ticks ${costs} do not cover 0.30 to 4.10`);

  const days = ticksOf(page, 'time');
  assert.ok(days.length >= 3);
  assert.ok(days.every((tick) => tick.endsWith('T00:00:00.000Z')), `time ticks ${days} are not on day boundaries`);
  assert.ok(days[0]! <= '2026-09-14T08:30:00.000Z' && days.at(-1)! >= '2026-09-27T21:45:00.000Z', `time ticks ${days} do not cover the span`);
});

interface Segment {
  provider: string;
  share: string;
  text: string;
}

const barsOf = (page: string): Map<string, Segment[]> =>
  new Map(
    [...page.matchAll(/<ul\s[^>]*data-provider-share="([^"]*)"[^>]*>([\s\S]*?)<\/ul>/g)].map(([, cohort, body]) => [
      cohort!,
      [...body!.matchAll(/<li\s([^>]*data-provider="[^"]*"[^>]*)>([\s\S]*?)<\/li>/g)].map(([, tag, text]) => ({
        provider: attribute(tag!, 'data-provider'),
        share: attribute(tag!, 'data-share'),
        text: textOf(text!),
      })),
    ]),
  );

test('given a cohort whose generations were served by two providers in a 3 to 1 token ratio, when the insights page is requested, then its provider bar splits 75% and 25%, naming each provider', async () => {
  const bars = barsOf(
    await dashboard([
      { id: 'p1', fingerprint: SONNET, seconds: 60, cost: 1, toolCalls: 1, retries: 0, providers: { Anthropic: 2000, 'Amazon Bedrock': 500 } },
      { id: 'p2', fingerprint: SONNET, seconds: 60, cost: 1, toolCalls: 1, retries: 0, providers: { Anthropic: 1000, 'Amazon Bedrock': 500 } },
    ]).page(),
  );

  assert.deepEqual(bars.get(fingerprintHash(SONNET)), [
    { provider: 'Anthropic', share: '75', text: 'Anthropic 75.0%' },
    { provider: 'Amazon Bedrock', share: '25', text: 'Amazon Bedrock 25.0%' },
  ]);
});

test('given workloads across two workers, when the insights page is requested filtered to one worker, then the chart and the provider bars show only that worker', async () => {
  const quick = { fingerprint: SONNET, seconds: 60, cost: 1, toolCalls: 1, retries: 0 };
  const { page } = dashboard([
    { id: 'x1', worker: 'builder', providers: { Anthropic: 100 }, ...quick },
    { id: 'x2', worker: 'builder', providers: { Anthropic: 100 }, ...quick },
    { id: 'y1', worker: 'refiner', providers: { 'Amazon Bedrock': 100 }, ...quick },
  ]);

  const filtered = await page('?worker=refiner');

  assert.deepEqual([...pointsOf(filtered).keys()], ['y1']);
  assert.deepEqual(barsOf(filtered).get(fingerprintHash(SONNET)), [{ provider: 'Amazon Bedrock', share: '100', text: 'Amazon Bedrock 100.0%' }]);
  assert.deepEqual([...pointsOf(await page()).keys()].sort(), ['x1', 'x2', 'y1']);
});

test('given a manual workload, when the insights page is requested with the manual filter, then its point has no outcome and is drawn as a square', async () => {
  const points = pointsOf(
    await dashboard([
      { id: 'm1', fingerprint: SONNET, dispatched: false, seconds: 60, cost: 0.6, toolCalls: 1, retries: 0 },
      { id: 'd1', fingerprint: SONNET, seconds: 60, cost: 0.1, toolCalls: 1, retries: 0 },
    ]).page('?manual=1'),
  );

  assert.deepEqual(
    [...points].map(([id, { outcome, shape }]) => [id, outcome, shape]).sort(),
    [['d1', 'failed', 'cross'], ['m1', 'manual', 'square']],
  );
});

test('given a pull request closed without merging and a cohort with no provider data, when the insights page is requested, then the point is an opened diamond and the cohort says it has no provider data', async () => {
  const page = await dashboard([
    { id: 'c1', fingerprint: SONNET, seconds: 60, cost: 0.1, toolCalls: 1, retries: 0, pullRequest: { state: 'closed', rework: 0 } },
  ]).page();

  assert.deepEqual([...pointsOf(page)].map(([id, { outcome, shape }]) => [id, outcome, shape]), [['c1', 'opened', 'diamond']]);
  assert.match(textOf(page), /No provider data/);
});

test('given workloads on the insights page, when the chart is requested, then it is a labelled group so the point titles stay reachable', async () => {
  const page = await dashboard(CHART_SEEDS).page();

  assert.match(page, /<svg[^>]*role="group"[^>]*data-chart="cost"|<svg[^>]*data-chart="cost"[^>]*role="group"/);
  assert.doesNotMatch(page, /<svg[^>]*role="img"[^>]*data-chart="cost"/);
});

test('given an OpenRouter cohort and a subscription cohort, when the insights page is requested, then no point of the OpenRouter cohort carries a list-price equivalent, the subscription points are titled as list-price equivalents, and the legend labels the subscription series', async () => {
  const subscribed: ConfigFingerprint = { ...SONNET, provider: 'anthropic' };
  const page = await dashboard([
    { id: 'o1', fingerprint: SONNET, seconds: 60, cost: 0.5, toolCalls: 1, retries: 0 },
    { id: 's1', fingerprint: subscribed, seconds: 60, cost: 0, listPrice: 2.5, toolCalls: 1, retries: 0 },
  ]).page();
  const points = pointsOf(page);
  const basisOf = (id: string): string =>
    page.match(new RegExp(`<g\\s[^>]*data-run="${id}"[^>]*data-cost-basis="([^"]*)"`))?.[1] ?? 'missing';

  assert.equal(points.get('o1')!.title, 'o1 - $0.500000 - failed');
  assert.equal(points.get('s1')!.title, 's1 - $2.500000 list-price equivalent - failed');
  assert.equal(basisOf('o1'), 'billed');
  assert.equal(basisOf('s1'), 'list-price');
  assert.notEqual(points.get('o1')!.color, points.get('s1')!.color);
  const legend = (hash: string): string =>
    textOf(page.match(new RegExp(`<li[^>]*data-legend-cohort="${hash}"[^>]*>[\\s\\S]*?</li>`))?.[0] ?? '');
  assert.doesNotMatch(legend(fingerprintHash(SONNET)), /subscription/);
  assert.match(legend(fingerprintHash(subscribed)), /subscription.*list-price equivalent/);
});
