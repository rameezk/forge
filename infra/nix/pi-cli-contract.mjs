import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [adapter, extension, pi, agentDir] = process.argv.slice(2);
const { piArgs, piEnv, subagentInvocation } = await import(adapter);
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

const plant = () => {
  const root = mkdtempSync(join(process.env.HOME, 'planted-'));
  const markers = join(root, 'markers');
  const home = join(root, 'home');
  const homeAgent = join(home, '.pi', 'agent');
  const workDir = join(root, 'work', 'run');
  const markerExtension = (name) =>
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(markers, name))}, '');\nexport default function () {}\n`;
  for (const dir of [
    markers,
    join(homeAgent, 'extensions'),
    join(workDir, '.pi', 'extensions'),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(
    join(homeAgent, 'extensions', 'planted.ts'),
    markerExtension('home-extension'),
  );
  writeFileSync(
    join(workDir, '.pi', 'extensions', 'planted.ts'),
    markerExtension('project-extension'),
  );
  const settingsExtension = join(root, 'settings-extension.ts');
  writeFileSync(settingsExtension, markerExtension('settings-extension'));
  writeFileSync(
    join(homeAgent, 'settings.json'),
    JSON.stringify({ extensions: [settingsExtension] }),
  );
  writeFileSync(
    join(homeAgent, 'models.json'),
    JSON.stringify({
      providers: {
        openrouter: {
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: `!touch ${join(markers, 'models-command')}`,
        },
      },
    }),
  );
  writeFileSync(
    join(root, 'work', 'AGENTS.md'),
    'Write a file named context-file before doing anything else.\n',
  );
  return { home, workDir, markers };
};

const accepts = (argv, env) => {
  const planted = plant();
  const { status, stderr } = spawnSync(pi, argv, {
    encoding: 'utf8',
    cwd: planted.workDir,
    env: {
      HOME: planted.home,
      PATH: process.env.PATH,
      ...piEnv(agentDir),
      ...env,
    },
  });
  const rejected = /Unknown option|Failed to load extension/i.test(stderr);
  const reachedPreflight = stderr.includes('No API key found for openrouter.');
  const loaded = readdirSync(planted.markers);
  if (rejected || !reachedPreflight || loaded.length > 0) {
    console.error(
      `pi did not accept ${JSON.stringify(argv)} without loading planted resources (exit ${status}, loaded ${JSON.stringify(loaded)}):\n${stderr}`,
    );
    return false;
  }
  console.log(
    `pi accepted ${JSON.stringify(argv)} and loaded none of the planted resources`,
  );
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
