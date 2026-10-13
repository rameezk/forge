import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiHarness } from '../src/index.ts';
import { PI_EXTENSIONS, writeFakeBwrap, writeFakePi } from './helpers.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'pi');

test('given a request record sink that fails to write, when pi records a request, then the harness run fails with that error instead of leaving it unhandled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-pi-'));
  const requests = join(dir, 'requests.jsonl');
  writeFileSync(requests, `${JSON.stringify({ type: 'request', body: {}, cacheMarkers: [] })}\n`);
  const harness = new PiHarness({
    command: writeFakePi(dir),
    openAgentDir: () => dir,
    extensions: PI_EXTENSIONS,
    sandbox: {
      bwrap: writeFakeBwrap(dir, {
        record: join(dir, 'bwrap-call.json'),
        harnessEnv: {
          FAKE_PI_RECORD: join(dir, 'pi-call.json'),
          FAKE_PI_OUTPUT: join(FIXTURES, 'success.jsonl'),
          FAKE_PI_REQUESTS: requests,
          FAKE_PI_LINGER_MS: '500',
        },
      }),
      home: dir,
    },
    system: { PATH: process.env.PATH ?? '' },
    env: {},
  });

  await assert.rejects(async () => {
    for await (const _event of harness.open({ runId: 'run-1', model: 'z-ai/glm-5', listedModel: null }).run(
      {
        model: 'z-ai/glm-5',
        prompt: 'refine',
        workDir: dir,
      },
      {
        stop: new AbortController().signal,
        rawEvent: () => {},
        requestRecord: () => {
          throw new Error('no space left on device');
        },
      },
    )) {
    }
  }, /no space left on device/);
});

test('given a read of a skill file, when pi reports its result, then each skill load is emitted before the event that caused it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-pi-'));
  const root = join(dir, 'repo');
  const skillFile = join(root, '.claude', 'skills', 'work-on', 'SKILL.md');
  const harness = new PiHarness({
    command: writeFakePi(dir),
    openAgentDir: () => dir,
    extensions: PI_EXTENSIONS,
    sandbox: {
      bwrap: writeFakeBwrap(dir, {
        record: join(dir, 'bwrap-call.json'),
        harnessEnv: {
          FAKE_PI_RECORD: join(dir, 'pi-call.json'),
          FAKE_PI_OUTPUT: join(FIXTURES, 'skill-loads.jsonl'),
        },
      }),
      home: dir,
    },
    system: { PATH: process.env.PATH ?? '' },
    env: {},
  });

  const types: string[] = [];
  for await (const event of harness
    .open({ runId: 'run-1', model: 'z-ai/glm-5', listedModel: null })
    .run(
      {
        model: 'z-ai/glm-5',
        prompt: 'review',
        workDir: dir,
        checkout: {
          root,
          skillPaths: [],
          projectInstructions: null,
          systemPrompt: null,
          appendSystemPrompt: null,
          skills: new Map([['work-on', [skillFile]]]),
          skillLines: new Map([[skillFile, 10]]),
        },
      },
      { stop: new AbortController().signal, rawEvent: () => {}, requestRecord: () => {} },
    )) {
    types.push(event.type === 'tool_call' ? `call:${event.name}` : event.type);
  }

  const result = types.indexOf('tool_result');
  assert.deepEqual(types.slice(result - 2, result + 1), [
    'call:read',
    'skill_load',
    'tool_result',
  ]);
});
