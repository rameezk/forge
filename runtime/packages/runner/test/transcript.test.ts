import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessEvent } from '@forge/shared';
import { FileTranscript } from '../src/index.ts';
import { message, result } from './helpers.ts';

const readLines = (path: string): HarnessEvent[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as HarnessEvent);

test('given a transcripts directory, when events are appended, then the ref names a per-run jsonl file that accumulates one event per line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-transcript-'));
  const transcript = FileTranscript.open(dir, 'run-77');
  const events = [message({ text: 'a' }), message({ text: 'b' }), result()];

  assert.equal(transcript.ref, 'run-77.jsonl');

  for (const event of events) {
    transcript.append(event);
  }
  transcript.close();

  assert.deepEqual(readLines(join(dir, transcript.ref)), events);
});

test('given an open transcript, when an event is appended, then it is flushed to disk before the run ends', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-transcript-'));
  const transcript = FileTranscript.open(dir, 'run-live');

  transcript.append(message({ text: 'first' }));

  assert.deepEqual(readLines(join(dir, transcript.ref)), [
    message({ text: 'first' }),
  ]);
  transcript.close();
});
