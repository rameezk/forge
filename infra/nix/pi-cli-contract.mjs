import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const [adapter, extension, pi] = process.argv.slice(2);
const { piArgs, subagentInvocation } = await import(adapter);
const { SUBAGENT_INVOCATION_ENV, childArgs } = await import(
  join(extension, 'index.ts')
);

const invocations = [
  {
    model: 'z-ai/glm-5',
    prompt: 'contract check',
    workDir: '.',
    reasoningEffort: 'high',
  },
  { model: 'z-ai/glm-5', prompt: 'contract check', workDir: '.' },
];

const accepts = (argv, env) => {
  const { status, stderr } = spawnSync(pi, argv, {
    encoding: 'utf8',
    env: { HOME: process.env.HOME, PATH: process.env.PATH, ...env },
  });
  const rejected = /Unknown option|Failed to load extension/i.test(stderr);
  const reachedPreflight = stderr.includes('No API key found for openrouter.');
  if (rejected || !reachedPreflight) {
    console.error(
      `pi did not accept ${JSON.stringify(argv)} (exit ${status}):\n${stderr}`,
    );
    return false;
  }
  console.log(`pi accepted ${JSON.stringify(argv)}`);
  return true;
};

let failed = false;
for (const invocation of invocations) {
  const child = subagentInvocation(pi, invocation);
  const parentAccepted = accepts(piArgs(invocation, extension), {
    [SUBAGENT_INVOCATION_ENV]: JSON.stringify(child),
  });
  const childAccepted = accepts(childArgs(child, 'contract check'), {});
  failed ||= !parentAccepted || !childAccepted;
}
process.exit(failed ? 1 : 0);
