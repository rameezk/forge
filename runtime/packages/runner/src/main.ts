import { mkdirSync } from 'node:fs';
import { resolveWorker } from './config.ts';
import { launchWorkload, readRuntimeConfig } from './workload.ts';

export const main = async (
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> => {
  const name = argv[0];
  if (name === undefined) {
    throw new Error('usage: run <worker>');
  }

  const config = readRuntimeConfig(env);
  const { run } = await launchWorkload({
    config,
    worker: resolveWorker(config, name),
    env,
    openWorkspace: (workDir) => {
      mkdirSync(workDir, { recursive: true });
      return { workDir };
    },
  });
  return run.status === 'error' ? 1 : 0;
};

if (import.meta.filename === process.argv[1]) {
  main(process.argv.slice(2), process.env)
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
