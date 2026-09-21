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

test('given a worker referencing an undeclared harness, when it is resolved, then it throws naming the harness', () => {
  const broken: RuntimeConfig = {
    harnesses: {},
    workers: { orphan: { harness: 'pi', model: 'm', prompt: 'p' } },
  };
  assert.throws(() => resolveWorker(broken, 'orphan'), /pi/);
});
