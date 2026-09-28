import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorker } from '../src/index.ts';
import type { RuntimeConfig } from '../src/index.ts';

const config: RuntimeConfig = {
  harnesses: {
    pi: { command: 'pi', args: ['--headless'] },
  },
  workers: {
    refiner: {
      harness: 'pi',
      model: 'anthropic/claude-opus-4',
      prompt: 'refine',
      reasoningEffort: 'high',
    },
    builder: {
      harness: 'pi',
      model: 'anthropic/claude-sonnet-4',
      prompt: 'build',
    },
  },
};

test('given a config, when a declared worker is resolved, then it carries its name and declared fields', () => {
  assert.deepEqual(resolveWorker(config, 'refiner'), {
    name: 'refiner',
    harness: 'pi',
    model: 'anthropic/claude-opus-4',
    prompt: 'refine',
    reasoningEffort: 'high',
  });
});

test('given a worker with no reasoning effort, when it is resolved, then reasoningEffort is absent', () => {
  const worker = resolveWorker(config, 'builder');
  assert.equal('reasoningEffort' in worker, false);
});

test('given a config, when an unknown worker is resolved, then it throws naming the worker', () => {
  assert.throws(() => resolveWorker(config, 'ghost'), /ghost/);
});

test('given a config, when a prototype key is resolved as a worker, then it throws rather than matching Object.prototype', () => {
  assert.throws(() => resolveWorker(config, '__proto__'), /unknown worker/);
  assert.throws(() => resolveWorker(config, 'constructor'), /unknown worker/);
});

test('given a worker referencing an undeclared harness, when it is resolved, then it throws naming the harness', () => {
  const broken: RuntimeConfig = {
    harnesses: {},
    workers: { orphan: { harness: 'pi', model: 'm', prompt: 'p' } },
  };
  assert.throws(() => resolveWorker(broken, 'orphan'), /pi/);
});

test('given a worker whose prompt starts with a dash or an at sign, when it is resolved, then it throws naming the worker, since pi would parse the prompt as an option or a file', () => {
  for (const prompt of ['- fix the flaky test', '@notes.md summarise']) {
    const risky: RuntimeConfig = {
      harnesses: { pi: { command: 'pi' } },
      workers: { risky: { harness: 'pi', model: 'm', prompt } },
    };
    assert.throws(() => resolveWorker(risky, 'risky'), /risky.*prompt/);
  }
});
