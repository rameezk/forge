import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Store } from '@forge/shared';
import { main } from '../src/main.ts';

const FAKE_PI = `
const lines = [
  { type: 'message', role: 'assistant', text: 'working', usage: { inputTokens: 30, outputTokens: 9 }, costUsd: 0.5 },
  { type: 'message', role: 'assistant', text: 'done', usage: { inputTokens: 0, outputTokens: 6 }, costUsd: 0.25 },
  { type: 'result', status: 'success', sessionId: 'sess-main', error: null },
];
for (const line of lines) process.stdout.write(JSON.stringify(line) + '\\n');
`;

const onlyRunId = (stateDir: string): string => {
  const files = readdirSync(join(stateDir, 'transcripts'));
  assert.equal(files.length, 1);
  return basename(files[0] as string, '.jsonl');
};

test('given a runtime config and a fake pi harness, when main runs a worker, then the run is recorded to the store and its transcript is written to disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-main-'));
  const fakePi = join(dir, 'fake-pi.mjs');
  writeFileSync(fakePi, FAKE_PI);

  const configPath = join(dir, 'runtime.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      harnesses: { pi: { command: process.execPath, args: [fakePi] } },
      workers: {
        refiner: {
          harness: 'pi',
          model: 'anthropic/claude-opus-4',
          prompt: 'refine',
        },
      },
    }),
  );

  const code = await main(['refiner'], {
    FORGE_RUNTIME_CONFIG: configPath,
    FORGE_STATE_DIR: dir,
  });

  assert.equal(code, 0);

  const runId = onlyRunId(dir);
  const store = Store.open(join(dir, 'forge.db'));
  const run = store.getRun(runId);
  store.close();

  assert.equal(run?.status, 'success');
  assert.equal(run?.worker, 'refiner');
  assert.equal(run?.harness, 'pi');
  assert.equal(run?.costUsd, 0.75);
  assert.equal(run?.inputTokens, 30);
  assert.equal(run?.outputTokens, 15);
  assert.equal(run?.sessionId, 'sess-main');
  assert.equal(run?.transcriptRef, `${runId}.jsonl`);

  const transcript = readFileSync(
    join(dir, 'transcripts', `${runId}.jsonl`),
    'utf8',
  );
  assert.match(transcript, /working/);
  assert.match(transcript, /done/);
});
