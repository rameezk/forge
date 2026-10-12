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
    provider: 'openrouter',
    reasoningEffort: 'high',
    timeoutSeconds: null,
    maxCostUsd: null,
  });
});

test('given a worker that sets openrouter and one that sets no provider, when they are resolved, then both carry the provider openrouter', () => {
  const explicit: RuntimeConfig = {
    harnesses: { pi: { command: 'pi' } },
    workers: {
      named: { harness: 'pi', model: 'm', prompt: 'p', provider: 'openrouter' },
      unset: { harness: 'pi', model: 'm', prompt: 'p' },
    },
  };
  assert.equal(resolveWorker(explicit, 'named').provider, 'openrouter');
  assert.equal(resolveWorker(explicit, 'unset').provider, 'openrouter');
});

test('given a claude-code worker that sets anthropic or sets no provider, when it is resolved, then it carries the provider anthropic', () => {
  const config: RuntimeConfig = {
    harnesses: { 'claude-code': { command: '/bin/claude' } },
    workers: {
      named: { harness: 'claude-code', model: 'claude-opus-4-5', prompt: 'p', provider: 'anthropic' },
      unset: { harness: 'claude-code', model: 'claude-opus-4-5', prompt: 'p' },
    },
  };

  assert.equal(resolveWorker(config, 'named').provider, 'anthropic');
  assert.equal(resolveWorker(config, 'unset').provider, 'anthropic');
});

test('given workers pairing a harness with a provider it cannot use, when they are resolved, then each throws naming the worker, the pair and the provider the harness takes', () => {
  const crossed: RuntimeConfig = {
    harnesses: { pi: { command: 'pi' }, 'claude-code': { command: '/bin/claude' } },
    workers: {
      piOnAnthropic: { harness: 'pi', model: 'm', prompt: 'p', provider: 'anthropic' },
      claudeOnOpenrouter: { harness: 'claude-code', model: 'm', prompt: 'p', provider: 'openrouter' },
    },
  };
  assert.throws(
    () => resolveWorker(crossed, 'piOnAnthropic'),
    /worker 'piOnAnthropic' pairs harness 'pi' with provider 'anthropic': harness 'pi' only takes provider openrouter/,
  );
  assert.throws(
    () => resolveWorker(crossed, 'claudeOnOpenrouter'),
    /worker 'claudeOnOpenrouter' pairs harness 'claude-code' with provider 'openrouter': harness 'claude-code' only takes provider anthropic/,
  );
});

test('given workers whose reasoning effort belongs to the other harness, when they are resolved, then each throws naming the worker, the harness and that harness own levels', () => {
  const crossed: RuntimeConfig = {
    harnesses: { pi: { command: 'pi' }, 'claude-code': { command: '/bin/claude' } },
    workers: {
      claudeOnPiLevel: { harness: 'claude-code', model: 'm', prompt: 'p', reasoningEffort: 'minimal' },
      piOnClaudeLevel: { harness: 'pi', model: 'm', prompt: 'p', reasoningEffort: 'ultracode' },
      claudeOnUltracode: { harness: 'claude-code', model: 'm', prompt: 'p', reasoningEffort: 'ultracode' },
    },
  };
  assert.throws(
    () => resolveWorker(crossed, 'claudeOnPiLevel'),
    /worker 'claudeOnPiLevel' reasoning effort 'minimal' must be one of low, medium, high, xhigh, max, ultracode for harness 'claude-code'/,
  );
  assert.throws(
    () => resolveWorker(crossed, 'piOnClaudeLevel'),
    /worker 'piOnClaudeLevel' reasoning effort 'ultracode' must be one of off, minimal, low, medium, high, xhigh, max for harness 'pi'/,
  );
  assert.equal(resolveWorker(crossed, 'claudeOnUltracode').reasoningEffort, 'ultracode');
});

test('given a worker whose provider is not allowed, when it is resolved, then it throws naming the worker and every allowed provider', () => {
  const unknown: RuntimeConfig = {
    harnesses: { pi: { command: 'pi' } },
    workers: {
      aws: { harness: 'pi', model: 'm', prompt: 'p', provider: 'bedrock' },
    },
  };
  assert.throws(
    () => resolveWorker(unknown, 'aws'),
    /worker 'aws' provider 'bedrock' must be one of openrouter, anthropic/,
  );
});

test('given workers with a timeout in seconds, with none, and with null, when they are resolved, then the timeout is carried, and absent and null both mean unlimited', () => {
  const timed: RuntimeConfig = {
    harnesses: { pi: { command: 'pi' } },
    workers: {
      capped: { harness: 'pi', model: 'm', prompt: 'p', timeoutSeconds: 7200 },
      open: { harness: 'pi', model: 'm', prompt: 'p', timeoutSeconds: null },
      unset: { harness: 'pi', model: 'm', prompt: 'p' },
    },
  };
  assert.equal(resolveWorker(timed, 'capped').timeoutSeconds, 7200);
  assert.equal(resolveWorker(timed, 'open').timeoutSeconds, null);
  assert.equal(resolveWorker(timed, 'unset').timeoutSeconds, null);
});

test('given workers with a budget in USD, with none, and with null, when they are resolved, then the budget is carried, and absent and null both mean unlimited', () => {
  const budgeted: RuntimeConfig = {
    harnesses: { pi: { command: 'pi' } },
    workers: {
      capped: { harness: 'pi', model: 'm', prompt: 'p', maxCostUsd: 2.5 },
      open: { harness: 'pi', model: 'm', prompt: 'p', maxCostUsd: null },
      unset: { harness: 'pi', model: 'm', prompt: 'p' },
    },
  };
  assert.equal(resolveWorker(budgeted, 'capped').maxCostUsd, 2.5);
  assert.equal(resolveWorker(budgeted, 'open').maxCostUsd, null);
  assert.equal(resolveWorker(budgeted, 'unset').maxCostUsd, null);
});

test('given a worker with no reasoning effort, when it is resolved, then reasoningEffort is absent', () => {
  const worker = resolveWorker(config, 'builder');
  assert.equal('reasoningEffort' in worker, false);
});

test('given a worker whose reasoning effort is outside the allowed levels, when it is resolved, then it throws naming the worker and every allowed level', () => {
  const typo: RuntimeConfig = {
    harnesses: { pi: { command: 'pi' } },
    workers: {
      typo: { harness: 'pi', model: 'm', prompt: 'p', reasoningEffort: 'hgih' },
    },
  };
  assert.throws(
    () => resolveWorker(typo, 'typo'),
    /worker 'typo' reasoning effort 'hgih' must be one of off, minimal, low, medium, high, xhigh, max for harness 'pi'/,
  );
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
