import { test } from 'node:test';
import assert from 'node:assert/strict';
import requestRecordExtension, { REQUEST_RECORD_FD_ENV } from '../src/index.ts';
import { recordOf } from '../src/contract.ts';

test('given no request record descriptor beyond pi\'s own stdio, when pi loads the extension, then it refuses to load naming the variable', (t) => {
  const previous = process.env[REQUEST_RECORD_FD_ENV];
  t.after(() => {
    if (previous === undefined) {
      delete process.env[REQUEST_RECORD_FD_ENV];
    } else {
      process.env[REQUEST_RECORD_FD_ENV] = previous;
    }
  });
  for (const value of [undefined, '', 'four', '-1', '0', '1', '2']) {
    if (value === undefined) {
      delete process.env[REQUEST_RECORD_FD_ENV];
    } else {
      process.env[REQUEST_RECORD_FD_ENV] = value;
    }

    assert.throws(
      () => requestRecordExtension({ on: () => undefined }),
      new RegExp(REQUEST_RECORD_FD_ENV),
    );
  }
});

test('given a provider payload with cache_control markers on its system prompt and messages, when it is recorded, then the markers are lifted out with their paths and the recorded system prompt carries none', () => {
  const marker = { type: 'ephemeral' };
  const lines = recordOf({
    model: 'anthropic/claude-opus-4.5',
    system: [{ type: 'text', text: 'be brief', cache_control: marker }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: marker }] },
    ],
  });

  const request = lines.at(-1);
  assert.equal(request?.type, 'request');
  assert.deepEqual(request.cacheMarkers, [
    { path: ['system', 0], value: marker },
    { path: ['messages', 0, 'content', 0], value: marker },
  ]);
  const prompts = lines.filter((line) => line.type === 'system_prompt');
  assert.equal(prompts.length, 1);
  assert.deepEqual(prompts[0]?.value, [{ type: 'text', text: 'be brief' }]);
});
