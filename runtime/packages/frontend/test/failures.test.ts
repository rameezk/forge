import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintHash } from '@forge/shared';
import { textOf } from './html.ts';
import { dashboard, GLM, SONNET, type Seed } from './insights-seed.ts';

const quick = { seconds: 60, cost: 0.1, toolCalls: 1, retries: 0 };

const PREVIOUS = '2026-09-20T10:00:00.000Z';

const SEEDS: Seed[] = [
  { id: 'g1', fingerprint: GLM, start: PREVIOUS, diagnoses: ['skill'], ...quick },
  { id: 'g2', fingerprint: GLM, start: PREVIOUS, diagnoses: ['forge'], ...quick },
  { id: 's1', fingerprint: SONNET, diagnoses: ['skill'], ...quick },
  { id: 's2', fingerprint: SONNET, diagnoses: ['skill'], ...quick },
  { id: 's3', fingerprint: SONNET, ...quick },
  { id: 's4', fingerprint: SONNET, kind: 'revision', failed: true, diagnoses: ['worker'], ...quick },
  { id: 's5', fingerprint: SONNET, pullRequest: { state: 'merged', rework: 0 }, ...quick },
  { id: 's6', fingerprint: SONNET, dispatched: false, worker: 'manual', ...quick },
];

const hash = fingerprintHash(SONNET);

const previousHash = fingerprintHash(GLM);

const failuresOf = (page: string, cohort: string): Record<string, string> => {
  const row = page.match(new RegExp(`<tr[^>]*\\sdata-cohort="${cohort}"[^>]*>([\\s\\S]*?)</tr>`))?.[1] ?? '';
  return Object.fromEntries([...row.matchAll(/<td[^>]*\sdata-metric="([^"]+)"[^>]*>([\s\S]*?)<\/td>/g)].filter(([, name]) => name !== 'label').map(([, name, cell]) => [name!, textOf(cell!)]));
};

const causesOf = (page: string): Record<string, string> => {
  const section = page.match(/<section[^>]*data-causes[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? '';
  return Object.fromEntries([...section.matchAll(/<li[^>]*\sdata-cause="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g)].map(([, name, text]) => [name!, textOf(text!)]));
};

const linkOf = (page: string, cohort: string, metric: string): string | undefined =>
  page.match(new RegExp(`<tr[^>]*\\sdata-cohort="${cohort}"[^>]*>[\\s\\S]*?<td[^>]*\\sdata-metric="${metric}"[^>]*>\\s*<a[^>]*\\shref="([^"]*)"`))?.[1]?.replaceAll('&amp;', '&');

const runsAt = async (app: { request: (path: string) => Response | Promise<Response> }, href: string): Promise<string[]> => {
  const body = await (await app.request(href)).text();
  return [...body.matchAll(/<tr[^>]*\sdata-run="([^"]*)"/g)].map((match) => match[1]!).sort();
};

test('given active cohorts with diagnosed and undiagnosed failures and a previous cohort with diagnosed failures, when the Failures tab opens, then the causes summary counts only the active cohorts and every cohort row shows its figures', async () => {
  const page = await dashboard(SEEDS).page('?tab=failures');

  assert.deepEqual(failuresOf(page, hash), {
    failed: '4',
    diagnosed: '3 of 4',
    'cause-worker': '1',
    'cause-skill': '2',
    'cause-ticket-or-spec': '0',
    'cause-repository-environment': '0',
    'cause-forge': '0',
    'cause-provider-and-infra': '0',
    'cause-unclear': '0',
  });
  assert.deepEqual(failuresOf(page, previousHash), {
    failed: '2',
    diagnosed: '2 of 2',
    'cause-worker': '0',
    'cause-skill': '1',
    'cause-ticket-or-spec': '0',
    'cause-repository-environment': '0',
    'cause-forge': '1',
    'cause-provider-and-infra': '0',
    'cause-unclear': '0',
  });
  assert.equal(causesOf(page)['failed'], 'Failed 4');
  assert.equal(causesOf(page)['diagnosed'], 'Diagnosed 3');
  assert.equal(causesOf(page)['undiagnosed'], 'Not diagnosed 1');
  assert.equal(causesOf(page)['skill'], 'Skill 2');
  assert.equal(causesOf(page)['worker'], 'Worker 1');
  assert.equal(causesOf(page)['forge'], 'Forge 0');
});

test('given a failed dispatch and a failed revision, when the Failures tab opens, then Kind is All and both are counted', async () => {
  const page = await dashboard(SEEDS).page('?tab=failures');

  assert.match(page, /<option value="all" selected>/);
  assert.equal(failuresOf(page, hash)['failed'], '4');
});

test('given a cohort with two skill failures, when its Skill count is followed, then Workloads lists exactly those two runs', async () => {
  const { app, page } = dashboard(SEEDS);
  const href = linkOf(await page('?tab=failures'), hash, 'cause-skill');

  assert.ok(href);
  assert.deepEqual(await runsAt(app, href), ['s1', 's2']);
});

test('given a cohort with failures, when its Failed count and a Causes bar are followed, then Workloads lists the failed runs and the diagnosed runs of every active cohort', async () => {
  const { app, page } = dashboard(SEEDS);
  const body = await page('?tab=failures');

  assert.deepEqual(await runsAt(app, linkOf(body, hash, 'failed')!), ['s1', 's2', 's3', 's4']);
  const bar = body.match(/<li[^>]*data-cause="skill"[^>]*>[\s\S]*?<a href="([^"]*)"/)?.[1];
  assert.ok(bar);
  assert.deepEqual(await runsAt(app, bar.replaceAll('&amp;', '&')), ['s1', 's2']);
});

test('given a failed manual workload in an active cohort, when the Failures tab opens with manual workloads requested, then no count includes it and the checkbox is hidden', async () => {
  const body = await dashboard(SEEDS).page('?tab=failures&manual=1');

  assert.equal(failuresOf(body, hash)['failed'], '4');
  assert.doesNotMatch(body, /name="manual"/);
  assert.match(await dashboard(SEEDS).page('?tab=delivery'), /name="manual"/);
});

test('given a failed run diagnosed twice with the later diagnosis failed, when the Failures tab opens, then the run counts as not diagnosed', async () => {
  const page = await dashboard([{ id: 'x1', fingerprint: SONNET, diagnoses: ['skill', 'failed'], ...quick }, { id: 'x2', fingerprint: SONNET, diagnoses: ['worker', 'skill'], ...quick }]).page('?tab=failures');

  assert.equal(failuresOf(page, hash)['diagnosed'], '1 of 2');
  assert.equal(failuresOf(page, hash)['cause-skill'], '1');
  assert.equal(failuresOf(page, hash)['cause-worker'], '0');
});

test('given diagnosis runs in the store, when the Failures tab opens with every filter widened, then no diagnosis cohort is listed', async () => {
  const body = await dashboard(SEEDS).page('?tab=failures&kind=all&manual=1');

  assert.equal([...body.matchAll(/<tr[^>]*\sdata-cohort="/g)].length, 2);
});

test('given a cohort with diagnosed failures, when its cohort page opens, then it shows that cohort alone', async () => {
  const { app } = dashboard(SEEDS);
  const page = await (await app.request(`/cohorts/${hash}`)).text();
  const section = page.match(/<section[^>]*data-failures[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? '';
  const metrics = Object.fromEntries([...section.matchAll(/<[a-z]+[^>]*\sdata-metric="([^"]+)"[^>]*>([\s\S]*?)<\/(?:a|span|div|td)>/g)].map(([, name, text]) => [name!, textOf(text!)]));

  assert.equal(metrics['failed'], '4');
  assert.equal(metrics['diagnosed'], '3 of 4');
  assert.equal(metrics['cause-skill'], '2');
  assert.equal(metrics['cause-worker'], '1');
});

test('given no active cohort under the chosen filters, when the Failures tab opens, then no Causes count links to an unrestricted Workloads list', async () => {
  const page = await dashboard([
    { id: 'p1', fingerprint: GLM, start: PREVIOUS, diagnoses: ['skill'], ...quick },
    { id: 'p2', fingerprint: SONNET, kind: 'revision', failed: true, ...quick },
  ]).page('?tab=failures&kind=dispatch');
  const section = page.match(/<section[^>]*data-causes[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? '';

  assert.ok(section.length > 0);
  const links = [...section.matchAll(/href="(\/workloads[^"]*)"/g)].map(([, href]) => href!);

  assert.deepEqual(links, []);
});
