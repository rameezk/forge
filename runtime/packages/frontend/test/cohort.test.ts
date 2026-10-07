import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintHash } from '@forge/shared';
import { textOf } from './html.ts';
import { dashboard, GLM, SONNET } from './insights-seed.ts';

const SEEDS = [{ id: 'a1', fingerprint: SONNET, seconds: 60, cost: 0.1, toolCalls: 1, retries: 0 }];

const fieldsOf = (page: string): Map<string, string> =>
  new Map(
    [...page.matchAll(/<tr[^>]*\sdata-field="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/g)].map(([, name, row]) => [
      name!,
      textOf(row!),
    ]),
  );

test('given a cohort, when its page is requested, then it shows the label and every field of the fingerprint', async () => {
  const { app } = dashboard(SEEDS);

  const page = await (await app.request(`/cohorts/${fingerprintHash(SONNET)}`)).text();

  assert.match(textOf(page), /sonnet-5\.5 · high · prompt#3fa2/);
  assert.deepEqual(fieldsOf(page), new Map([
    ['model', 'Model anthropic/claude-sonnet-5.5'],
    ['reasoning-effort', 'Reasoning effort high'],
    ['harness-args', 'Harness extra args none'],
    ['harness-version', 'Harness version 1.0.0'],
    ['prompt-template', 'Prompt template 3fa2c9d1'],
    ['system-prompt', 'System prompt s'],
    ['tools', 'Tool definitions t'],
    ['skills', 'Skill files k'],
  ]));
});

const RESKILLED = { ...SONNET, skills: 'k2' };

const changedFieldsOf = (page: string): string[] =>
  [...page.matchAll(/<tr[^>]*\sdata-field="([^"]+)"[^>]*\sdata-changed="true"/g)].map(([, name]) => name!);

test('given two cohorts differing only in the skill files hash, when one is requested with the other chosen, then the diff marks only the skill files hash as changed', async () => {
  const { app } = dashboard([...SEEDS, { id: 'a2', fingerprint: RESKILLED, seconds: 60, cost: 0.1, toolCalls: 1, retries: 0 }]);

  const page = await (await app.request(`/cohorts/${fingerprintHash(SONNET)}?against=${fingerprintHash(RESKILLED)}`)).text();

  assert.deepEqual(changedFieldsOf(page), ['skills']);
  assert.equal(fieldsOf(page).get('skills'), 'Skill files changed k k2');
  assert.equal(fieldsOf(page).get('model'), 'Model anthropic/claude-sonnet-5.5 anthropic/claude-sonnet-5.5');
});

const choicesOf = (page: string): { value: string; selected: boolean; text: string }[] =>
  [...(page.match(/<select[^>]*\sname="against"[^>]*>([\s\S]*?)<\/select>/)?.[1] ?? '').matchAll(/<option([^>]*)>([\s\S]*?)<\/option>/g)]
    .map(([, attributes, text]) => ({
      value: /\svalue="([^"]*)"/.exec(attributes!)?.[1] ?? '',
      selected: /\sselected/.test(attributes!),
      text: textOf(text!),
    }))
    .filter(({ value }) => value !== '');

test('given three cohorts, when one is requested with another chosen, then the page offers the other two to compare against and marks the chosen one', async () => {
  const { app } = dashboard([
    ...SEEDS,
    { id: 'a2', fingerprint: RESKILLED, seconds: 60, cost: 0.1, toolCalls: 1, retries: 0 },
    { id: 'b1', fingerprint: GLM, seconds: 60, cost: 0.1, toolCalls: 1, retries: 0 },
  ]);

  const page = await (await app.request(`/cohorts/${fingerprintHash(SONNET)}?against=${fingerprintHash(GLM)}`)).text();

  assert.deepEqual(
    choicesOf(page).map(({ value, selected }) => [value, selected]).sort(),
    [[fingerprintHash(RESKILLED), false], [fingerprintHash(GLM), true]].sort(),
  );
  assert.ok(choicesOf(page).every(({ text }) => text.includes('·')));
});

test('given workloads recorded without a fingerprint, when the unknown-config cohort page is requested, then it says they predate fingerprints and offers no diff', async () => {
  const { app } = dashboard([
    ...SEEDS,
    { id: 'old', seconds: 60, cost: 0.1, toolCalls: 1, retries: 0 },
  ]);

  const response = await app.request('/cohorts/unknown');
  const page = await response.text();

  assert.equal(response.status, 200);
  assert.match(textOf(page), /unknown config/);
  assert.match(textOf(page), /recorded before fingerprints existed/);
  assert.equal(fieldsOf(page).size, 0);
  assert.doesNotMatch(page, /name="against"/);
});

test('given no workload of a cohort, when its page is requested, then it is not found', async () => {
  const { app } = dashboard(SEEDS);

  assert.equal((await app.request(`/cohorts/${'0'.repeat(64)}`)).status, 404);
  assert.equal((await app.request('/cohorts/unknown')).status, 404);
});

const cohortLinksOf = (page: string): string[] =>
  [...page.matchAll(/<a\s(?:[^>]*\s)?href="(\/cohorts\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map(([, href, label]) => `${href} ${textOf(label!)}`);

test('given a workload with a fingerprint, when the insights page and its run detail page are requested, then its cohort label links to the cohort page on both', async () => {
  const { app } = dashboard(SEEDS);
  const link = `/cohorts/${fingerprintHash(SONNET)} sonnet-5.5 · high · prompt#3fa2`;

  assert.deepEqual(cohortLinksOf(await (await app.request('/insights')).text()), [link]);
  assert.deepEqual(cohortLinksOf(await (await app.request('/runs/a1')).text()), [link]);
});

test('given a workload recorded without a fingerprint, when the insights page and its run detail page are requested, then the unknown config links to the unknown-config cohort page', async () => {
  const { app } = dashboard([{ id: 'old', seconds: 60, cost: 0.1, toolCalls: 1, retries: 0 }]);
  const link = '/cohorts/unknown unknown config';

  assert.deepEqual(cohortLinksOf(await (await app.request('/insights')).text()), [link]);
  assert.deepEqual(cohortLinksOf(await (await app.request('/runs/old')).text()), [link]);
});
