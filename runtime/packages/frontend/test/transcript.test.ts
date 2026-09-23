import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTranscriptSource } from '../src/index.ts';

test('given a ref inside the directory, when read, then its events are returned', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-t-'));
  writeFileSync(
    join(dir, 'run.jsonl'),
    `${JSON.stringify({ type: 'result', status: 'success', sessionId: null, error: null })}\n`,
  );

  const events = new FileTranscriptSource(dir).read('run.jsonl');

  assert.equal(events.length, 1);
});

test('given a ref that escapes the directory, when read, then it is rejected before any file access', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-t-'));
  const source = new FileTranscriptSource(dir);

  assert.throws(() => source.read('../escape.jsonl'), /transcript/i);
  assert.throws(() => source.read('/etc/passwd'), /transcript/i);
});
