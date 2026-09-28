import { spawnSync } from 'node:child_process';

const [adapter, pi] = process.argv.slice(2);
const { piArgs } = await import(adapter);

const invocations = [
  {
    model: 'z-ai/glm-5',
    prompt: 'contract check',
    workDir: '.',
    reasoningEffort: 'high',
  },
  { model: 'z-ai/glm-5', prompt: 'contract check', workDir: '.' },
];

let failed = false;
for (const invocation of invocations) {
  const argv = piArgs(invocation);
  const { status, stderr } = spawnSync(pi, argv, {
    encoding: 'utf8',
    env: { HOME: process.env.HOME, PATH: process.env.PATH },
  });
  const rejected = /Unknown option/i.test(stderr);
  const reachedPreflight = stderr.includes('No API key found for openrouter.');
  if (rejected || !reachedPreflight) {
    console.error(
      `pi did not accept ${JSON.stringify(argv)} (exit ${status}):\n${stderr}`,
    );
    failed = true;
  } else {
    console.log(`pi accepted ${JSON.stringify(argv)}`);
  }
}
process.exit(failed ? 1 : 0);
