import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cohortLabel,
  fingerprintHash,
  type ConfigFingerprint,
} from '../src/index.ts';

const aFingerprint = (
  overrides: Partial<ConfigFingerprint> = {},
): ConfigFingerprint => ({
  model: 'anthropic/claude-sonnet-5.5',
  reasoningEffort: 'high',
  harnessArgs: ['--skill', '/opt/skills/review'],
  harnessVersion: '1.0.0',
  promptTemplate: '3fa2c9d1',
  systemPrompt: 'a1',
  tools: 'b2',
  skills: 'c3',
  ...overrides,
});

test('given two fingerprints holding the same fields, when hashed, then the hashes are equal whatever order the fields were built in', () => {
  const reordered = Object.fromEntries(
    Object.entries(aFingerprint()).reverse(),
  ) as unknown as ConfigFingerprint;

  assert.equal(fingerprintHash(reordered), fingerprintHash(aFingerprint()));
});

test('given two fingerprints differing only in their skills hash, when hashed, then the hashes differ', () => {
  assert.notEqual(
    fingerprintHash(aFingerprint({ skills: 'c4' })),
    fingerprintHash(aFingerprint()),
  );
});

test('given a fingerprint, when labelled, then the label names the model, the effort and a short prompt hash', () => {
  assert.equal(cohortLabel(aFingerprint()), 'sonnet-5.5 · high · prompt#3fa2');
});

test('given a fingerprint with no reasoning effort, when labelled, then the label says default', () => {
  assert.equal(
    cohortLabel(aFingerprint({ reasoningEffort: null })),
    'sonnet-5.5 · default · prompt#3fa2',
  );
});

test('given no fingerprint, when labelled, then the label is the unknown config', () => {
  assert.equal(cohortLabel(null), 'unknown config');
});
