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
    for await (const _event of harness.run(
      { model: 'z-ai/glm-5', prompt: 'refine', workDir: dir, agentDir: dir },
      {
        rawEvent: () => {},
        requestRecord: () => {
          throw new Error('no space left on device');
        },
      },
    )) {
    }
  }, /no space left on device/);
});
