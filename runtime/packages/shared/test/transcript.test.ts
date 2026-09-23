import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript, transcriptLine } from '../src/index.ts';
import type { HarnessEvent } from '../src/index.ts';

const events: [HarnessEvent, HarnessEvent, HarnessEvent] = [
  { type: 'message', role: 'user', text: 'refine the spec', usage: { inputTokens: 1, outputTokens: 0 }, costUsd: 0 },
  { type: 'message', role: 'assistant', text: 'done', usage: { inputTokens: 0, outputTokens: 2 }, costUsd: 0.01 },
  { type: 'result', status: 'success', sessionId: 'sess-abc', error: null },
];

test('given events, when each is written as a transcript line and parsed back, then they round-trip', () => {
  const contents = events.map(transcriptLine).join('');

  assert.deepEqual(parseTranscript(contents), events);
});

test('given a transcript with a blank line, when parsed, then the blank line is ignored', () => {
  const contents = `${transcriptLine(events[0])}\n${transcriptLine(events[2])}`;

  assert.deepEqual(parseTranscript(contents), [events[0], events[2]]);
});

test('given empty content, when parsed, then it yields no events', () => {
  assert.deepEqual(parseTranscript(''), []);
});
