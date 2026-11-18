import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessOutput } from '@forge/shared';
import type { HarnessRegistry, RuntimeConfig } from '../src/index.ts';
import { launchWorkload, type LaunchResult } from '../src/workload.ts';
import { resolveWorker } from '../src/config.ts';
import { fakeOpenRouter, LISTED_MODELS, billedAt, NO_BASIS } from './helpers.ts';

type Script = (stop: AbortSignal) => AsyncIterable<HarnessOutput>;

const registryOf = (script: Script): HarnessRegistry => ({
  scripted: () => ({
    open: () => ({
      identity: async () => ({ version: '1.0.0', args: [] }),
      fingerprintBasis: () => NO_BASIS,
      run: (_invocation, sinks) => script(sinks.stop),
    }),
  }),
});

const completes: Script = async function* () {
  yield { type: 'result', status: 'success', sessionId: 's', error: null };
};

const reportsError =
  (error: string | null): Script =>
  async function* () {
    yield { type: 'result', status: 'error', sessionId: 's', error };
  };

const launch = async (
  script: Script,
  worker: { model?: string; timeoutSeconds?: number; maxCostUsd?: number } = {},
): Promise<{ result: LaunchResult; lines: string[] }> => {
  const stateDir = mkdtempSync(join(tmpdir(), 'forge-workload-log-'));
  const openRouter = await fakeOpenRouter(billedAt({}), LISTED_MODELS);
  const config: RuntimeConfig = {
    harnesses: { scripted: { command: '/not/used' } },
    workers: {
      demo: { harness: 'scripted', model: 'z-ai/glm-5', prompt: 'go', ...worker },
    },
  };
  const lines: string[] = [];
  try {
    const result = await launchWorkload({
      config,
      worker: resolveWorker(config, 'demo'),
      env: {
        FORGE_STATE_DIR: stateDir,
        OPENROUTER_BASE_URL: openRouter.baseUrl,
        OPENROUTER_API_KEY: 'sk-or-test',
      },
      openWorkspace: (workDir) => ({ workDir }),
      harnesses: registryOf(script),
      log: (line) => lines.push(line),
    });
    return { result, lines };
  } finally {
    openRouter.close();
  }
};

const prefixOf = (result: LaunchResult): string =>
  `run ${result.run.id.slice(0, 8)} (demo) ended`;

test('given a worker whose harness completes normally, when the workload is launched, then log receives exactly the success line', async () => {
  const { result, lines } = await launch(completes);

  assert.deepEqual(lines, [`${prefixOf(result)} success`]);
});

test('given a harness that reports 401: API key expired, when the workload is launched, then log receives the error line with that reason', async () => {
  const { result, lines } = await launch(reportsError('401: API key expired'));

  assert.deepEqual(lines, [`${prefixOf(result)} error: 401: API key expired`]);
});

test('given a budgeted worker whose model cannot be priced, when the workload is launched, then log receives an error line carrying the refusal the run records', async () => {
  const { result, lines } = await launch(completes, {
    model: 'z-ai/unlisted',
    maxCostUsd: 1,
  });

  assert.match(result.run.error ?? '', /could not be priced/);
  assert.deepEqual(lines, [`${prefixOf(result)} error: ${result.run.error}`]);
});

test('given a run that goes past its timeout, when the workload is launched, then log receives an exceeded line with the recorded reason', async () => {
  const { result, lines } = await launch(
    async function* (stop) {
      await new Promise((resolve) => stop.addEventListener('abort', resolve));
    },
    { timeoutSeconds: 1 },
  );

  assert.equal(result.run.status, 'exceeded');
  assert.deepEqual(lines, [
    `${prefixOf(result)} exceeded: the workload was stopped after its timeout was exceeded`,
  ]);
});

test('given a launch that ends in error with no recorded error but a cause, when the workload is launched, then the reason is the cause message', async () => {
  let reads = 0;
  const cause = new Error('unused');
  Object.defineProperty(cause, 'message', {
    get: () => (reads++ === 0 ? '' : 'the cause message'),
  });
  const { result, lines } = await launch(async function* () {
    throw cause;
  });

  assert.equal(result.run.error, '');
  assert.deepEqual(lines, [`${prefixOf(result)} error: the cause message`]);
});

test('given a recorded error spanning several lines, when the workload is launched, then log is called once with the reason unchanged', async () => {
  const reason = 'first line\nsecond line\nthird line';
  const { result, lines } = await launch(reportsError(reason));

  assert.deepEqual(lines, [`${prefixOf(result)} error: ${reason}`]);
});

test('given a cause message that carries the provider key and no recorded error, when the workload is launched, then the key is redacted from the logged reason', async () => {
  let reads = 0;
  const cause = new Error('unused');
  Object.defineProperty(cause, 'message', {
    get: () => (reads++ === 0 ? '' : 'rejected sk-or-test'),
  });
  const { result, lines } = await launch(async function* () {
    throw cause;
  });

  assert.deepEqual(lines, [`${prefixOf(result)} error: rejected [redacted]`]);
});
