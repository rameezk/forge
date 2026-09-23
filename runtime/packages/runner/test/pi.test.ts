import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePiEvent, piArgs } from '../src/index.ts';
import { aWorker } from './helpers.ts';

test('given a pi message line, when parsed, then it becomes a message event with usage and cost', () => {
  const line = JSON.stringify({
    type: 'message',
    role: 'assistant',
    text: 'hi',
    usage: { inputTokens: 12, outputTokens: 3 },
    costUsd: 0.004,
  });

  assert.deepEqual(parsePiEvent(line), {
    type: 'message',
    role: 'assistant',
    text: 'hi',
    usage: { inputTokens: 12, outputTokens: 3 },
    costUsd: 0.004,
  });
});

test('given a pi result line, when parsed, then it becomes a result event', () => {
  const line = JSON.stringify({
    type: 'result',
    status: 'success',
    sessionId: 'sess-1',
    error: null,
  });

  assert.deepEqual(parsePiEvent(line), {
    type: 'result',
    status: 'success',
    sessionId: 'sess-1',
    error: null,
  });
});

test('given a blank line, when parsed, then it is ignored', () => {
  assert.equal(parsePiEvent('   '), null);
});

test('given a line of an unknown type, when parsed, then it throws', () => {
  assert.throws(() => parsePiEvent(JSON.stringify({ type: 'weird' })), /weird/);
});

test('given a worker, when pi args are built, then model and prompt are passed and effort only when declared', () => {
  assert.deepEqual(piArgs(aWorker({ reasoningEffort: 'high' })), [
    '--model',
    'anthropic/claude-opus-4',
    '--reasoning-effort',
    'high',
    '--prompt',
    'do the thing',
  ]);

  assert.deepEqual(piArgs(aWorker()), [
    '--model',
    'anthropic/claude-opus-4',
    '--prompt',
    'do the thing',
  ]);
});
