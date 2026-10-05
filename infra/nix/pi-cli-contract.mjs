import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const [
  adapter,
  subagentExtension,
  modelDefaultReasoningExtension,
  requestRecordExtension,
  pi,
  piPackage,
] = process.argv.slice(2);
const extensions = {
  subagent: subagentExtension,
  modelDefaultReasoning: modelDefaultReasoningExtension,
  requestRecord: requestRecordExtension,
};
const { piArgs, piEnv, subagentInvocation } = await import(adapter);
const { agentDirsIn } = await import(join(dirname(adapter), 'agent-dir.ts'));
const { loadPiSkills, resolveCheckout } = await import(
  join(dirname(adapter), 'checkout.ts')
);
const loadSkills = await loadPiSkills(piPackage);
const { default: REASONING_EFFORTS } = await import(
  join(dirname(adapter), 'reasoning-efforts.json'),
  { with: { type: 'json' } }
);
const { SUBAGENT_INVOCATION_ENV, childArgs } = await import(
  join(subagentExtension, 'index.ts')
);

const skill = (name) =>
  `---\nname: ${name}\ndescription: Contract check skill.\n---\n\nCheck the contract.\n`;

const checkoutFiles = {
  '.claude/skills/prompted-skill/SKILL.md': skill('prompted-skill'),
  '.pi/skills/second-skill-dir/SKILL.md': skill('second-skill-dir'),
  'AGENTS.md': 'Project instructions for the contract check.\n',
  '.pi/SYSTEM.md': 'System prompt for the contract check.\n',
  '.pi/APPEND_SYSTEM.md': 'Appended system prompt for the contract check.\n',
};

const agentDirs = agentDirsIn(mkdtempSync(join(process.env.HOME, 'agents-')));

const readOnlyAgentDir = (name, model, listed) =>
  agentDirs(name, model, listed);

const contractAgentDir = readOnlyAgentDir('contract', 'z-ai/glm-5', null);

const invocations = [
  ...REASONING_EFFORTS.map((reasoningEffort) => () => ({
    model: 'z-ai/glm-5',
    prompt: 'contract check',
    workDir: '.',
    agentDir: contractAgentDir,
    reasoningEffort,
  })),
  () => ({
    model: 'z-ai/glm-5',
    prompt: 'contract check',
    workDir: '.',
    agentDir: contractAgentDir,
  }),
  ...[{ reasoningEffort: 'high' }, {}].map((effort) => (workDir) => {
    for (const [path, contents] of Object.entries(checkoutFiles)) {
      mkdirSync(dirname(join(workDir, path)), { recursive: true });
      writeFileSync(join(workDir, path), contents);
    }
    return {
      model: 'z-ai/glm-5',
      prompt: '/prompted-skill contract check',
      workDir,
      agentDir: contractAgentDir,
      ...effort,
      checkout: resolveCheckout(workDir, loadSkills),
    };
  }),
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
    join(workDir, '.pi', 'skills', 'planted-skill'),
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
  writeFileSync(
    join(workDir, '.pi', 'skills', 'planted-skill', 'SKILL.md'),
    skill('planted-skill'),
  );
  const settingsExtension = join(root, 'settings-extension.ts');
  writeFileSync(settingsExtension, markerExtension('settings-extension'));
  writeFileSync(
    join(homeAgent, 'settings.json'),
    JSON.stringify({ extensions: [settingsExtension] }),
  );
  const projectSettingsExtension = join(root, 'project-settings-extension.ts');
  writeFileSync(
    projectSettingsExtension,
    markerExtension('project-settings-extension'),
  );
  writeFileSync(
    join(workDir, '.pi', 'settings.json'),
    JSON.stringify({ extensions: [projectSettingsExtension] }),
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

const accepts = (planted, argv, env, agent = contractAgentDir) => {
  const { status, stderr } = spawnSync(pi, argv, {
    encoding: 'utf8',
    cwd: planted.workDir,
    env: {
      HOME: planted.home,
      PATH: process.env.PATH,
      ...piEnv(agent),
      ...env,
    },
  });
  const rejected =
    /Unknown option|Failed to load extension|Invalid thinking level/i.test(
      stderr,
    );
  const reachedPreflight = stderr.includes('No API key found for openrouter.');
  const loaded = readdirSync(planted.markers);
  if (rejected || !reachedPreflight || loaded.length > 0) {
    console.error(
      `pi did not accept ${JSON.stringify(argv)} next to planted resources (exit ${status}, loaded ${JSON.stringify(loaded)}):\n${stderr}`,
    );
    return false;
  }
  console.log(
    `pi accepted ${JSON.stringify(argv)} and loaded none of the planted resources`,
  );
  return true;
};

const MISSING_MODEL = 'forge-contract/model-missing-from-pi';
const DECLARED_CONTEXT_WINDOW = 123456;
const DECLARED_CONTEXT_LISTED = '123.5K';

const startsWithModel = (agentDir) => {
  const planted = plant();
  const invocation = {
    model: MISSING_MODEL,
    prompt: 'contract check',
    workDir: planted.workDir,
    agentDir,
    reasoningEffort: 'high',
  };
  const env = {
    HOME: planted.home,
    PATH: process.env.PATH,
    ...piEnv(agentDir),
    [SUBAGENT_INVOCATION_ENV]: JSON.stringify(
      subagentInvocation(pi, invocation, extensions),
    ),
  };
  const started = spawnSync(pi, piArgs(invocation, extensions), {
    encoding: 'utf8',
    cwd: planted.workDir,
    env,
  });
  const listed = spawnSync(pi, ['--offline', '--no-approve', '--list-models', MISSING_MODEL], {
    encoding: 'utf8',
    cwd: planted.workDir,
    env: { ...env, OPENROUTER_API_KEY: 'sk-contract' },
  });
  return {
    warned: /not found/i.test(started.stderr),
    reachedPreflight: started.stderr.includes('No API key found for openrouter.'),
    listedContext: listed.stdout
      .split('\n')
      .find((line) => line.includes(MISSING_MODEL))
      ?.trim()
      .split(/\s+/)[2],
    stderr: started.stderr,
    listed: listed.stdout + listed.stderr,
  };
};

const readsDeclaredModel = () => {
  const declared = readOnlyAgentDir('declared', MISSING_MODEL, {
    price: { input: 0.000002, output: 0.00001, cacheRead: 0.0000002, cacheWrite: null },
    contextWindow: DECLARED_CONTEXT_WINDOW,
    maxOutputTokens: 8000,
    reasoning: true,
  });
  const undeclared = readOnlyAgentDir('undeclared', MISSING_MODEL, null);
  const without = startsWithModel(undeclared);
  const withModel = startsWithModel(declared);
  const ok =
    without.warned &&
    !withModel.warned &&
    withModel.reachedPreflight &&
    withModel.listedContext === DECLARED_CONTEXT_LISTED;
  if (!ok) {
    console.error(
      `pi did not read the declared model from the agent dir's models.json (without it: ${JSON.stringify(without)}, with it: ${JSON.stringify(withModel)})`,
    );
    return false;
  }
  console.log(
    `pi read ${MISSING_MODEL} from the agent dir's models.json, warned about it without one, and listed its declared context window ${DECLARED_CONTEXT_LISTED}`,
  );
  return true;
};

let failed = !readsDeclaredModel();
for (const invocationIn of invocations) {
  const parent = plant();
  const invocation = invocationIn(parent.workDir);
  const child = subagentInvocation(pi, invocation, extensions);
  const parentAccepted = accepts(parent, piArgs(invocation, extensions), {
    [SUBAGENT_INVOCATION_ENV]: JSON.stringify(child),
  });
  const childAccepted = accepts(
    plant(),
    childArgs(child, 'contract check'),
    {},
  );
  failed ||= !parentAccepted || !childAccepted;
}
process.exit(failed ? 1 : 0);
