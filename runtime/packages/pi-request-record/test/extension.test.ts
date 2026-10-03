import { test } from 'node:test';
import assert from 'node:assert/strict';
import requestRecordExtension, { REQUEST_RECORD_FD_ENV } from '../src/index.ts';

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
