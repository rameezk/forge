import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '@forge/shared';
import type { RuntimeConfig } from './config.ts';
import { resolveWorker } from './config.ts';
import type { Harness, Worker } from './harness.ts';
import { PiHarness } from './pi.ts';
import { FileTranscript } from './transcript.ts';
import { runWorkload } from './runner.ts';

const harnessFor = (
  config: RuntimeConfig,
  worker: Worker,
  env: NodeJS.ProcessEnv,
): Harness => {
  const harness = config.harnesses[worker.harness];
  if (harness === undefined || worker.harness !== 'pi') {
    throw new Error(`unsupported harness '${worker.harness}'`);
  }
  return new PiHarness({
    command: harness.command,
    ...(harness.args === undefined ? {} : { baseArgs: harness.args }),
    env,
  });
};

export const main = async (
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> => {
  const name = argv[0];
  if (name === undefined) {
    throw new Error('usage: run <worker>');
  }

  const configPath = env.FORGE_RUNTIME_CONFIG;
  if (configPath === undefined) {
    throw new Error('FORGE_RUNTIME_CONFIG is not set');
  }
  const stateDir = env.FORGE_STATE_DIR;
  if (stateDir === undefined) {
    throw new Error('FORGE_STATE_DIR is not set');
  }

  const config = JSON.parse(readFileSync(configPath, 'utf8')) as RuntimeConfig;
  const worker = resolveWorker(config, name);
  const harness = harnessFor(config, worker, env);

  const transcriptsDir = join(stateDir, 'transcripts');
  mkdirSync(transcriptsDir, { recursive: true });
  const store = Store.open(join(stateDir, 'forge.db'));

  try {
    const id = await runWorkload({
      store,
      harness,
      worker,
      openTranscript: (runId) => FileTranscript.open(transcriptsDir, runId),
      now: () => new Date().toISOString(),
      newId: () => randomUUID(),
    });
    return store.getRun(id)?.status === 'error' ? 1 : 0;
  } finally {
    store.close();
  }
};

if (import.meta.filename === process.argv[1]) {
  main(process.argv.slice(2), process.env)
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
