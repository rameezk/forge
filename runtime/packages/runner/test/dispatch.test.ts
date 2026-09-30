import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store, type RunRecord } from '@forge/shared';
import { main } from '../src/dispatch-main.ts';
import { journaled, PI_CONTRACT, lockedPiPackage, writeFakePi } from './helpers.ts';

const GITHUB_FIXTURES = join(import.meta.dirname, 'fixtures', 'github');

const PI_OUTPUT = join(import.meta.dirname, 'fixtures', 'pi', 'success.jsonl');

const EXTENSION = join(import.meta.dirname, '..', '..', 'pi-subagent', 'src');

const AGENT_DIR = '/nix/store/00000000000000000000000000000000-pi-agent-dir';

const GITHUB_TOKEN = 'github_pat_test';

const TICKET_URL = 'https://github.com/rameezk/forge/issues/113';

interface IssueResponse {
  data: {
    repository: {
      issue: { labels: { nodes: { name: string }[] } } | null;
    };
  };
}

const recorded = (name: string): IssueResponse =>
  JSON.parse(
    readFileSync(join(GITHUB_FIXTURES, `${name}.json`), 'utf8'),
  ) as IssueResponse;

const labelled = (response: IssueResponse, label: string): IssueResponse => {
  const copy = structuredClone(response);
  copy.data.repository.issue?.labels.nodes.push({ name: label });
  return copy;
};

const FORGE_READY = 'forge:ready';

interface GraphqlRequest {
  authorization: string | null;
  variables: Record<string, unknown>;
}

const replaying = (responses: Record<number, IssueResponse>) => {
  const requests: GraphqlRequest[] = [];
  const fetch = async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as {
      variables: Record<string, unknown>;
    };
    requests.push({
      authorization: new Headers(init?.headers).get('authorization'),
      variables: body.variables,
    });
    const response = responses[Number(body.variables.number)];
    if (response === undefined) {
      throw new Error(`no recorded response for ${String(body.variables.number)}`);
    }
    return new Response(JSON.stringify(response), {
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, requests };
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    ['-c', 'user.name=Forge Test', '-c', 'user.email=forge@example.com', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();

const SKILL = '---\nname: work-on\ndescription: Drive one ticket to a pull request.\n---\n\nWork on it.\n';

interface Origin {
  path: string;
  tip: string;
}

const originWith = (
  files: Record<string, string>,
  links: Record<string, string> = {},
): Origin => {
  const path = mkdtempSync(join(tmpdir(), 'forge-origin-'));
  git(path, 'init', '--quiet', '--initial-branch', 'main');
  git(path, 'config', 'uploadpack.allowFilter', 'true');
  writeFileSync(join(path, 'README.md'), 'first\n');
  git(path, 'add', '.');
  git(path, 'commit', '--quiet', '-m', 'first');
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(path, file)), { recursive: true });
    writeFileSync(join(path, file), contents);
  }
  for (const [link, target] of Object.entries(links)) {
    mkdirSync(dirname(join(path, link)), { recursive: true });
    symlinkSync(target, join(path, link));
  }
  writeFileSync(join(path, 'README.md'), 'tip\n');
  git(path, 'add', '.');
  git(path, 'commit', '--quiet', '-m', 'tip');
  git(path, 'branch', 'other', 'HEAD~1');
  return { path, tip: git(path, 'rev-parse', 'HEAD') };
};

interface Scenario {
  origin?: Origin;
  repository?: string;
  issue?: number;
  responses?: Record<number, IssueResponse>;
  prompt?: string;
  tokenFile?: string | null;
  piOutput?: string;
}

interface PiCall {
  argv: string[];
  cwd: string;
  subagentInvocation: string | undefined;
  githubToken: string | undefined;
  nodeOptions: string | undefined;
}

interface Outcome {
  code: number;
  transcript: string;
  stateDir: string;
  origin: Origin;
  runs: RunRecord[];
  pi: PiCall | null;
  requests: GraphqlRequest[];
}

const dispatch = async (scenario: Scenario = {}): Promise<Outcome> => {
  const origin =
    scenario.origin ??
    originWith({ '.claude/skills/work-on/SKILL.md': SKILL });
  const stateDir = mkdtempSync(join(tmpdir(), 'forge-dispatch-'));
  const record = join(stateDir, 'pi-call.json');
  const configPath = join(stateDir, 'runtime.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      harnesses: { pi: { command: writeFakePi(stateDir) } },
      workers: {
        builder: {
          harness: 'pi',
          model: 'z-ai/glm-5',
          prompt: scenario.prompt ?? '/work-on {url}',
        },
      },
      repositories: {
        forge: { github: 'rameezk/forge', worker: 'builder' },
      },
    }),
  );
  const tokenFile = join(stateDir, 'github.env');
  const tokenFileContents =
    scenario.tokenFile === undefined
      ? `GITHUB_TOKEN=${GITHUB_TOKEN}\n`
      : scenario.tokenFile;
  if (tokenFileContents !== null) {
    writeFileSync(tokenFile, tokenFileContents);
  }
  const github = replaying(
    scenario.responses ?? {
      113: labelled(recorded('frontier-ticket'), FORGE_READY),
    },
  );

  const code = await main(
    [scenario.repository ?? 'forge', String(scenario.issue ?? 113)],
    {
      PATH: process.env.PATH,
      HOME: stateDir,
      FORGE_RUNTIME_CONFIG: configPath,
      FORGE_STATE_DIR: stateDir,
      FORGE_PI_SUBAGENT_EXTENSION: EXTENSION,
      FORGE_PI_AGENT_DIR: AGENT_DIR,
      FORGE_PI_PACKAGE: lockedPiPackage(),
      FORGE_GITHUB_TOKEN_FILE: tokenFile,
      GITHUB_TOKEN: 'github_pat_from_the_environment',
      OPENROUTER_API_KEY: 'sk-or-test',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.${pathToFileURL(origin.path).href}.insteadOf`,
      GIT_CONFIG_VALUE_0: 'https://github.com/rameezk/forge.git',
      FAKE_PI_RECORD: record,
      FAKE_PI_OUTPUT: scenario.piOutput ?? PI_OUTPUT,
    },
    github.fetch,
  );

  const store = Store.open(join(stateDir, 'forge.db'));
  try {
    const [run] = store.listRuns();
    return {
      code,
      transcript:
        run?.transcriptRef == null
          ? ''
          : readFileSync(join(stateDir, 'transcripts', run.transcriptRef), 'utf8'),
      stateDir,
      origin,
      runs: store.listRuns(),
      pi: existsSync(record)
        ? (JSON.parse(readFileSync(record, 'utf8')) as PiCall)
        : null,
      requests: github.requests,
    };
  } finally {
    store.close();
  }
};

test('given a frontier ticket labelled forge:ready in a repository whose worker prompt is /work-on {url}, when forge-dispatch runs, then pi starts in a fresh blobless clone of the default branch tip under the state directory with the prompt /skill:work-on and the ticket url, and the run records the repository and ticket', async () => {
  const { code, stateDir, origin, runs, pi, requests } = await dispatch();

  assert.equal(code, 0);
  assert.ok(pi);
  assert.equal(pi.argv.at(-1), `/skill:work-on ${TICKET_URL}`);
  const workDir = realpathSync(pi.cwd);
  assert.ok(workDir.startsWith(realpathSync(stateDir) + sep));
  assert.equal(git(workDir, 'rev-parse', 'HEAD'), origin.tip);
  assert.equal(git(workDir, 'branch', '--show-current'), 'main');
  assert.equal(git(workDir, 'config', 'remote.origin.partialclonefilter'), 'blob:none');
  assert.equal(git(workDir, 'status', '--porcelain'), '');
  assert.deepEqual(requests, [
    {
      authorization: `bearer ${GITHUB_TOKEN}`,
      variables: { owner: 'rameezk', name: 'forge', number: 113 },
    },
  ]);
  const [run, ...others] = runs;
  assert.deepEqual(others, []);
  assert.ok(run);
  assert.equal(run.worker, 'builder');
  assert.equal(run.status, 'success');
  assert.deepEqual(run.ticket, {
    repository: 'forge',
    number: 113,
    url: TICKET_URL,
  });
});

test('given a ticket labelled forge:ready that has an open blocker, one that is closed, one that is not ready-for-agent, and a frontier ticket without the label, when forge-dispatch runs for each, then none starts a workload or clones, and each refusal names why', async () => {
  const cases = [
    { issue: 115, fixture: 'blocked-ticket', label: true, reason: /forge#115 is not dispatchable: it has open blockers/ },
    { issue: 109, fixture: 'closed-ticket', label: true, reason: /forge#109 is not dispatchable: it is closed/ },
    { issue: 112, fixture: 'spec-ticket', label: true, reason: /forge#112 is not dispatchable: it is not labelled ready-for-agent/ },
    { issue: 113, fixture: 'frontier-ticket', label: false, reason: /forge#113 is not dispatchable: it is not labelled forge:ready/ },
  ];
  for (const { issue, fixture, label, reason } of cases) {
    const response = label
      ? labelled(recorded(fixture), FORGE_READY)
      : recorded(fixture);
    const { result, journal } = await journaled(() =>
      dispatch({ issue, responses: { [issue]: response } }),
    );

    assert.equal(result.code, 1, fixture);
    assert.deepEqual(result.runs, [], fixture);
    assert.equal(result.pi, null, fixture);
    assert.equal(existsSync(join(result.stateDir, 'work')), false, fixture);
    assert.match(journal, reason);
  }
});

const projectInstructions = (path: string): string[] => [
  '--append-system-prompt',
  `<project_context>\n\nProject-specific instructions and guidelines:\n\n<project_instructions path="${path}">`,
  '--append-system-prompt',
  path,
  '--append-system-prompt',
  '</project_instructions>\n\n</project_context>',
];

const childArgv = (pi: PiCall): string[] =>
  (JSON.parse(pi.subagentInvocation ?? 'null') as { argv: string[] }).argv;

test('given a checkout root with .claude/skills, .pi/skills, AGENTS.md, CLAUDE.md and .pi/SYSTEM.md and no .agents/skills, when the workload starts, then pi and the subagent invocation get the two skill paths, the system prompt file, AGENTS.md framed as project instructions, and the unattended instruction, and nothing for what does not exist', async () => {
  const { pi } = await dispatch({
    origin: originWith({
      '.claude/skills/work-on/SKILL.md': SKILL,
      '.pi/skills/review/SKILL.md': SKILL.replace('work-on', 'review'),
      'AGENTS.md': 'Agents instructions\n',
      'CLAUDE.md': 'Claude instructions\n',
      '.pi/SYSTEM.md': 'System prompt\n',
    }),
  });

  assert.ok(pi);
  const root = realpathSync(pi.cwd);
  const unattended = pi.argv[pi.argv.indexOf('-e') - 1] ?? '';
  assert.match(unattended, /no human will answer/);
  const flags = [
    ...PI_CONTRACT,
    '--skill',
    join(root, '.claude', 'skills'),
    '--skill',
    join(root, '.pi', 'skills'),
    '--system-prompt',
    join(root, '.pi', 'SYSTEM.md'),
    ...projectInstructions(join(root, 'AGENTS.md')),
    '--append-system-prompt',
    unattended,
  ];
  assert.deepEqual(pi.argv, [
    ...flags,
    '-e',
    EXTENSION,
    `/skill:work-on ${TICKET_URL}`,
  ]);
  assert.deepEqual(childArgv(pi).slice(1), flags);
});

test('given a checkout root with only CLAUDE.md, .agents/skills and .pi/APPEND_SYSTEM.md, when the workload starts, then CLAUDE.md is framed as project instructions and the append file is passed before it, with no system prompt file', async () => {
  const { pi } = await dispatch({
    origin: originWith({
      '.agents/skills/work-on/SKILL.md': SKILL,
      'CLAUDE.md': 'Claude instructions\n',
      '.pi/APPEND_SYSTEM.md': 'Appended\n',
    }),
  });

  assert.ok(pi);
  const root = realpathSync(pi.cwd);
  const flags = pi.argv.slice(PI_CONTRACT.length, pi.argv.indexOf('-e') - 2);
  assert.deepEqual(flags, [
    '--skill',
    join(root, '.agents', 'skills'),
    '--append-system-prompt',
    join(root, '.pi', 'APPEND_SYSTEM.md'),
    ...projectInstructions(join(root, 'CLAUDE.md')),
  ]);
});

test('given a worker prompt /work-on {url} and a checkout with no work-on skill, when forge-dispatch runs, then pi never starts and the run records that the skill was not found', async () => {
  const { code, runs, pi } = await journaled(() =>
    dispatch({
      origin: originWith({
        '.pi/skills/review/SKILL.md': SKILL.replace('work-on', 'review'),
      }),
    }),
  ).then(({ result }) => result);

  assert.equal(code, 1);
  assert.equal(pi, null);
  const [run] = runs;
  assert.equal(run?.status, 'error');
  assert.equal(run?.error, "skill 'work-on' not found in the checkout");
  assert.equal(run?.ticket?.number, 113);
});

test('given a checkout whose skills directory and AGENTS.md are symlinks to outside the checkout, when forge-dispatch runs, then neither is passed and the work-on skill they would bring is not found', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'forge-outside-'));
  mkdirSync(join(outside, 'skills', 'work-on'), { recursive: true });
  writeFileSync(join(outside, 'skills', 'work-on', 'SKILL.md'), SKILL);
  writeFileSync(join(outside, 'AGENTS.md'), 'Outside instructions\n');

  const { runs, pi } = await journaled(() =>
    dispatch({
      origin: originWith(
        {},
        {
          '.claude/skills': join(outside, 'skills'),
          'AGENTS.md': join(outside, 'AGENTS.md'),
        },
      ),
    }),
  ).then(({ result }) => result);

  assert.equal(pi, null);
  assert.equal(runs[0]?.error, "skill 'work-on' not found in the checkout");
});

test('given worker prompts using the {repo}, {issue} and {url} placeholders, with and without a leading skill command, when forge-dispatch runs, then each placeholder is filled for the ticket and only the leading command becomes a pi skill command', async () => {
  const withCommand = await dispatch({ prompt: '/work-on {repo}#{issue} at {url}' });
  const withoutCommand = await dispatch({ prompt: 'Build {repo}#{issue}: {url}' });

  assert.equal(
    withCommand.pi?.argv.at(-1),
    `/skill:work-on rameezk/forge#113 at ${TICKET_URL}`,
  );
  assert.equal(
    withoutCommand.pi?.argv.at(-1),
    `Build rameezk/forge#113: ${TICKET_URL}`,
  );
});

test('given a repository whose clone fails, when forge-dispatch runs, then pi never starts and the run records why git could not clone it', async () => {
  const origin = { path: join(tmpdir(), 'forge-origin-missing'), tip: '' };

  const { code, runs, pi } = await journaled(() => dispatch({ origin })).then(
    ({ result }) => result,
  );

  assert.equal(code, 1);
  assert.equal(pi, null);
  assert.equal(runs[0]?.status, 'error');
  assert.match(runs[0]?.error ?? '', /^git could not clone rameezk\/forge: /);
});

test('given an issue GitHub cannot find and a repository that is not declared, when forge-dispatch runs for each, then it fails naming the problem', async () => {
  await assert.rejects(
    dispatch({ issue: 99999, responses: { 99999: recorded('missing-ticket') } }),
    /GitHub found no ticket rameezk\/forge#99999: Could not resolve to an Issue with the number of 99999\./,
  );
  await assert.rejects(
    dispatch({ repository: 'elsewhere' }),
    /unknown repository 'elsewhere'/,
  );
});

test('given a GitHub token file that also sets NODE_OPTIONS and quotes the token, and a different GITHUB_TOKEN in the environment, when forge-dispatch runs, then it asks GitHub with the file token alone, and pi gets neither a GitHub token nor anything else from the file', async () => {
  const { requests, pi } = await dispatch({
    tokenFile: `NODE_OPTIONS=--require /var/lib/forge/planted.js\n  GITHUB_TOKEN = "${GITHUB_TOKEN}"  \n`,
  });

  assert.deepEqual(
    requests.map((request) => request.authorization),
    [`bearer ${GITHUB_TOKEN}`],
  );
  assert.ok(pi);
  assert.equal(pi.githubToken, undefined);
  assert.equal(pi.nodeOptions, undefined);
});

test('given no GitHub token file, or one that sets no token, when forge-dispatch runs, then it fails naming the missing token without asking GitHub', async () => {
  for (const tokenFile of [null, 'OTHER=value\n']) {
    await assert.rejects(dispatch({ tokenFile }), /GitHub token missing/);
  }
});

test('given an agent that reads the GitHub token from the state directory and repeats it, when forge-dispatch runs, then the transcript carries it redacted', async () => {
  const piOutput = join(mkdtempSync(join(tmpdir(), 'forge-output-')), 'pi.jsonl');
  writeFileSync(
    piOutput,
    readFileSync(PI_OUTPUT, 'utf8').replaceAll('All done.', `All done. ${GITHUB_TOKEN}`),
  );

  const { transcript } = await dispatch({ piOutput });

  assert.match(transcript, /All done\. \[redacted\]/);
  assert.ok(!transcript.includes(GITHUB_TOKEN));
});

test('given work-on skill directories that pi would not load as work-on, because their frontmatter names another skill or gives no description, when forge-dispatch runs, then pi never starts and the skill is not found, while one naming itself only by its directory is found', async () => {
  for (const skill of [
    '---\nname: other\ndescription: Drive one ticket.\n---\n',
    '---\nname: work-on\n---\n',
    '---\nname: work-on\ndescription: ""\n---\n',
    'No frontmatter at all.\n',
  ]) {
    const { pi, runs } = await journaled(() =>
      dispatch({ origin: originWith({ '.claude/skills/work-on/SKILL.md': skill }) }),
    ).then(({ result }) => result);

    assert.equal(pi, null, skill);
    assert.equal(runs[0]?.error, "skill 'work-on' not found in the checkout", skill);
  }

  const { pi } = await dispatch({
    origin: originWith({
      '.claude/skills/work-on/SKILL.md': "---\ndescription: 'Drive one ticket.'\n---\n",
    }),
  });
  assert.equal(pi?.argv.at(-1), `/skill:work-on ${TICKET_URL}`);
});

test('given a checkout with two different files pi would load as work-on, from two skill directories, from a differently named directory, from a nested directory, from a markdown file at a skill directory root, or from below a SKILL.md an ignore file hides, when forge-dispatch runs, then pi never starts and the run names both files', async () => {
  const other = SKILL.replace('Work on it.', 'Work on it differently.');
  for (const [files, paths] of [
    [
      { '.claude/skills/work-on/SKILL.md': SKILL, '.pi/skills/work-on/SKILL.md': other },
      '.claude/skills/work-on/SKILL.md, .pi/skills/work-on/SKILL.md',
    ],
    [
      { '.claude/skills/work-on/SKILL.md': SKILL, '.agents/skills/drive/SKILL.md': other },
      '.agents/skills/drive/SKILL.md, .claude/skills/work-on/SKILL.md',
    ],
    [
      { '.claude/skills/work-on/SKILL.md': SKILL, '.claude/skills/team/drive/SKILL.md': other },
      '.claude/skills/team/drive/SKILL.md, .claude/skills/work-on/SKILL.md',
    ],
    [
      { '.claude/skills/work-on/SKILL.md': SKILL, '.pi/skills/work-on.md': other },
      '.claude/skills/work-on/SKILL.md, .pi/skills/work-on.md',
    ],
    [
      {
        '.claude/skills/.ignore': 'decoy/SKILL.md\n',
        '.claude/skills/decoy/SKILL.md': SKILL.replace('work-on', 'decoy'),
        '.claude/skills/decoy/real/SKILL.md': other,
        '.pi/skills/work-on/SKILL.md': SKILL,
      },
      '.claude/skills/decoy/real/SKILL.md, .pi/skills/work-on/SKILL.md',
    ],
  ] as const) {
    const { pi, runs } = await journaled(() =>
      dispatch({ origin: originWith(files) }),
    ).then(({ result }) => result);

    assert.equal(pi, null, paths);
    assert.equal(
      runs[0]?.error,
      `skill 'work-on' is ambiguous in the checkout: ${paths}`,
    );
  }
});

test('given a checkout whose work-on skill appears in two skill directories through a symlink to one file, once under a directory named differently from it, or beside a dot file pi skips that also names itself work-on, when forge-dispatch runs, then pi starts with /skill:work-on', async () => {
  for (const origin of [
    originWith(
      { '.agents/skills/work-on/SKILL.md': SKILL },
      { '.claude/skills/work-on': '../../.agents/skills/work-on' },
    ),
    originWith({ '.agents/skills/drive/SKILL.md': SKILL }),
    originWith({
      '.agents/skills/work-on/SKILL.md': SKILL,
      '.agents/skills/.draft.md': SKILL.replace('Work on it.', 'Draft.'),
    }),
  ]) {
    const { pi } = await dispatch({ origin });

    assert.equal(pi?.argv.at(-1), `/skill:work-on ${TICKET_URL}`);
  }
});

test('given a skill whose frontmatter name is a number, when forge-dispatch runs a prompt naming its directory, then pi never starts and the skill is not found, as pi names it by the number', async () => {
  const { pi, runs } = await journaled(() =>
    dispatch({
      origin: originWith({
        '.claude/skills/123/SKILL.md': '---\nname: 123\ndescription: Numbered.\n---\n',
      }),
      prompt: '/123 {url}',
    }),
  ).then(({ result }) => result);

  assert.equal(pi, null);
  assert.equal(runs[0]?.error, "skill '123' not found in the checkout");
});

test('given a checkout with a link under a skill directory that resolves outside the checkout, directly or through a directory elsewhere in the checkout, when forge-dispatch runs, then pi never starts and the run names the link', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'forge-outside-'));
  writeFileSync(join(outside, 'notes.md'), 'Outside notes\n');

  for (const [origin, link] of [
    [
      originWith(
        { '.claude/skills/work-on/SKILL.md': SKILL },
        { '.claude/skills/work-on/notes.md': join(outside, 'notes.md') },
      ),
      '.claude/skills/work-on/notes.md',
    ],
    [
      originWith(
        { '.claude/skills/work-on/SKILL.md': SKILL, 'docs/README.md': 'Docs\n' },
        {
          '.claude/skills/shared': '../../docs',
          'docs/outside': outside,
        },
      ),
      '.claude/skills/shared/outside',
    ],
  ] as const) {
    const { pi, runs } = await journaled(() => dispatch({ origin })).then(
      ({ result }) => result,
    );

    assert.equal(pi, null, link);
    assert.equal(
      runs[0]?.error,
      `'${link}' in the checkout's skills links outside the checkout`,
    );
  }
});

test('given a checkout whose skill directory links to a directory that itself holds a directory link, once or in a loop back to itself, when forge-dispatch runs, then pi never starts and the run names the inner link', async () => {
  for (const [origin, link] of [
    [
      originWith(
        {
          '.claude/skills/work-on/SKILL.md': SKILL,
          'docs/skills/review/SKILL.md': SKILL.replace('work-on', 'review'),
        },
        {
          '.claude/skills/shared': '../../docs/skills',
          'docs/skills/again': 'review',
        },
      ),
      '.claude/skills/shared/again',
    ],
    [
      originWith(
        { '.claude/skills/work-on/SKILL.md': SKILL },
        {
          '.claude/skills/loop/p': '..',
          '.claude/skills/loop/q': '..',
          '.claude/skills/loop/r': '..',
        },
      ),
      '.claude/skills/loop/p/loop/p',
    ],
  ] as const) {
    const { pi, runs } = await journaled(() => dispatch({ origin })).then(
      ({ result }) => result,
    );

    assert.equal(pi, null, link);
    assert.equal(
      runs[0]?.error,
      `'${link}' in the checkout's skills links to a directory from inside a linked directory`,
    );
  }
});

test('given a checkout where a second file named work-on is reached through two links, when forge-dispatch runs, then the run names each distinct file once', async () => {
  const { pi, runs } = await journaled(() =>
    dispatch({
      origin: originWith(
        {
          '.claude/skills/work-on/SKILL.md': SKILL,
          '.agents/skills/drive/SKILL.md': SKILL.replace('Work on it.', 'Drive it.'),
        },
        { '.pi/skills/drive': '../../.agents/skills/drive' },
      ),
    }),
  ).then(({ result }) => result);

  assert.equal(pi, null);
  assert.equal(
    runs[0]?.error,
    "skill 'work-on' is ambiguous in the checkout: .agents/skills/drive/SKILL.md, .claude/skills/work-on/SKILL.md",
  );
});

test('given a worker prompt whose skill command is followed by a newline rather than a space, when forge-dispatch runs, then pi never starts, as pi would not expand it', async () => {
  const { pi, runs } = await journaled(() =>
    dispatch({ prompt: '/work-on\n{url}' }),
  ).then(({ result }) => result);

  assert.equal(pi, null);
  assert.equal(
    runs[0]?.error,
    `skill 'work-on\n${TICKET_URL}' not found in the checkout`,
  );
});
