import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store, type RevisionRecord, type RunRecord } from '@forge/shared';
import { main } from '../src/revise-main.ts';
import { UNATTENDED_INSTRUCTION } from '../src/harness.ts';
import {
  APP_ID,
  fakeGithubApp,
  routedThrough,
} from '../../shared/test/fixtures/fake-github-app.ts';
import {
  billedAt,
  fakeOpenRouter,
  lockedPiPackage,
  PI_EXTENSIONS,
  writeFakeBwrap,
  writeFakePi,
} from './helpers.ts';

const GITHUB_FIXTURES = join(import.meta.dirname, 'fixtures', 'github');

const PI_OUTPUT = join(import.meta.dirname, 'fixtures', 'pi', 'success.jsonl');

const PULL_REQUEST_URL = 'https://github.com/rameezk/forge/pull/143';

const GIT_IDENTITY = { name: 'Forge Operator', email: 'operator@example.com' };

interface PullRequestResponse {
  data: {
    repository: {
      pullRequest: {
        state: string;
        isCrossRepository: boolean;
        headRefName: string;
        closingIssuesReferences: { nodes: { number: number }[] };
      } | null;
    };
  };
}

const pullRequestFixture = (): PullRequestResponse =>
  JSON.parse(
    readFileSync(join(GITHUB_FIXTURES, 'pull-request.json'), 'utf8'),
  ) as PullRequestResponse;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    ['-c', 'user.name=Forge Test', '-c', 'user.email=forge@example.com', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();

const SKILL =
  '---\nname: address-feedback\ndescription: Address review feedback on a pull request.\n---\n\nAddress it.\n';

interface Origin {
  path: string;
  mainTip: string;
  featureTip: string;
}

const originWith = (featureFiles: Record<string, string>): Origin => {
  const path = mkdtempSync(join(tmpdir(), 'forge-origin-'));
  git(path, 'init', '--quiet', '--initial-branch', 'main');
  git(path, 'config', 'uploadpack.allowFilter', 'true');
  writeFileSync(join(path, 'README.md'), 'main\n');
  git(path, 'add', '.');
  git(path, 'commit', '--quiet', '-m', 'main');
  const mainTip = git(path, 'rev-parse', 'HEAD');
  git(path, 'switch', '--quiet', '-c', 'feature');
  for (const [file, contents] of Object.entries(featureFiles)) {
    mkdirSync(dirname(join(path, file)), { recursive: true });
    writeFileSync(join(path, file), contents);
  }
  writeFileSync(join(path, 'README.md'), 'feature\n');
  git(path, 'add', '.');
  git(path, 'commit', '--quiet', '-m', 'feature');
  const featureTip = git(path, 'rev-parse', 'HEAD');
  git(path, 'switch', '--quiet', 'main');
  return { path, mainTip, featureTip };
};

interface PiCall {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

interface Scenario {
  origin?: Origin;
  prompt?: string;
  pullRequest?: PullRequestResponse;
  seed?: (store: Store) => void;
  maxConcurrent?: number;
}

interface Outcome {
  code: number;
  origin: Origin;
  runs: RunRecord[];
  revisions: RevisionRecord[];
  complaints: string;
  pi: PiCall | null;
  gitConfig: Record<string, string>;
}

const gitConfigOf = (entries: Record<string, string>): Record<string, string> =>
  Object.fromEntries([
    ['GIT_CONFIG_COUNT', String(Object.keys(entries).length)],
    ...Object.entries(entries).flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value],
    ]),
  ]);

const revise = async (scenario: Scenario = {}): Promise<Outcome> => {
  const origin =
    scenario.origin ?? originWith({ '.claude/skills/address-feedback/SKILL.md': SKILL });
  const stateDir = mkdtempSync(join(tmpdir(), 'forge-revise-'));
  const record = join(stateDir, 'pi-call.json');
  const configPath = join(stateDir, 'runtime.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      harnesses: { pi: { command: writeFakePi(stateDir) } },
      workers: {
        reviser: {
          harness: 'pi',
          model: 'z-ai/glm-5',
          prompt: scenario.prompt ?? '/address-feedback {url} on {branch} of {repo} (#{pr})',
        },
      },
      repositories: {
        forge: { github: 'rameezk/forge', on: { feedback: 'reviser' } },
      },
      dispatch: {
        gitIdentity: GIT_IDENTITY,
        ...(scenario.maxConcurrent === undefined ? {} : { maxConcurrent: scenario.maxConcurrent }),
      },
    }),
  );
  const app = fakeGithubApp(['rameezk/forge']);
  const privateKeyFile = join(stateDir, 'github-app-private-key');
  writeFileSync(privateKeyFile, app.privateKey);
  const pullRequest = scenario.pullRequest ?? pullRequestFixture();
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    assert.equal(new URL(String(input)).pathname, '/graphql');
    return new Response(JSON.stringify(pullRequest), {
      headers: { 'content-type': 'application/json' },
    });
  };
  if (scenario.seed !== undefined) {
    const seeded = Store.open(join(stateDir, 'forge.db'));
    try {
      scenario.seed(seeded);
    } finally {
      seeded.close();
    }
  }
  const gitConfig = gitConfigOf({
    [`url.${pathToFileURL(origin.path).href}.insteadOf`]:
      'https://github.com/rameezk/forge.git',
  });
  const openRouter = await fakeOpenRouter(billedAt({}), null);
  const complaints: string[] = [];
  const complain = console.error;
  console.error = (line: string) => complaints.push(line);
  const code = await main(
    ['forge', '143'],
    {
      PATH: process.env.PATH,
      HOME: stateDir,
      FORGE_NIX_SYSTEM: 'x86_64-linux',
      FORGE_RUNTIME_CONFIG: configPath,
      FORGE_STATE_DIR: stateDir,
      FORGE_PI_SUBAGENT_EXTENSION: PI_EXTENSIONS.subagent,
      FORGE_PI_MODEL_DEFAULT_REASONING_EXTENSION: PI_EXTENSIONS.modelDefaultReasoning,
      FORGE_PI_REQUEST_RECORD_EXTENSION: PI_EXTENSIONS.requestRecord,
      FORGE_PI_PACKAGE: lockedPiPackage(),
      FORGE_BWRAP: writeFakeBwrap(stateDir, {
        record: join(stateDir, 'bwrap-call.json'),
        harnessEnv: { FAKE_PI_RECORD: record, FAKE_PI_OUTPUT: PI_OUTPUT },
      }),
      FORGE_GITHUB_APP_ID: APP_ID,
      FORGE_GITHUB_APP_PRIVATE_KEY_FILE: privateKeyFile,
      OPENROUTER_API_KEY: 'sk-or-test',
      OPENROUTER_BASE_URL: openRouter.baseUrl,
      ...gitConfig,
    },
    routedThrough(app, fetch),
  ).finally(() => {
    console.error = complain;
    return openRouter.close();
  });

  const store = Store.open(join(stateDir, 'forge.db'));
  try {
    return {
      code,
      origin,
      runs: store.listRuns(),
      revisions: store.listRevisions(new Date().toISOString()),
      complaints: complaints.join('\n'),
      pi: existsSync(record) ? (JSON.parse(readFileSync(record, 'utf8')) as PiCall) : null,
      gitConfig,
    };
  } finally {
    store.close();
  }
};

test('given a repository with on.feedback and an open pull request on branch feature, when forge-revise runs, then the feedback worker starts in a fresh clone of feature with the placeholders filled, and a commit it pushes lands on feature', async () => {
  const { code, origin, pi, gitConfig } = await revise();

  assert.equal(code, 0);
  assert.ok(pi);
  assert.equal(
    pi.argv.at(-1),
    `/skill:address-feedback ${PULL_REQUEST_URL} on feature of rameezk/forge (#143)`,
  );
  const workDir = realpathSync(pi.cwd);
  assert.equal(git(workDir, 'branch', '--show-current'), 'feature');
  assert.equal(git(workDir, 'rev-parse', 'HEAD'), origin.featureTip);
  execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'address feedback'], {
    cwd: workDir,
    env: { ...pi.env, ...gitConfig },
  });
  execFileSync('git', ['push', '--quiet', 'origin', 'HEAD'], {
    cwd: workDir,
    env: { ...pi.env, ...gitConfig },
  });
  assert.equal(git(origin.path, 'log', '-1', '--format=%s', 'feature'), 'address feedback');
});

test('given a feedback worker whose prompt starts with /address-feedback, when the pull request\'s branch has no such skill, then the revision fails before pi starts, and when it has the skill, pi runs it', async () => {
  const missing = await revise({
    origin: originWith({ '.claude/skills/other/SKILL.md': SKILL.replace('address-feedback', 'other') }),
  });
  const present = await revise();

  assert.equal(missing.code, 1);
  assert.equal(missing.pi, null);
  assert.equal(missing.runs[0]?.status, 'error');
  assert.equal(missing.runs[0]?.error, "skill 'address-feedback' not found in the checkout");
  assert.deepEqual(missing.revisions.map(({ state }) => state), ['error']);
  assert.match(present.pi?.argv.at(-1) ?? '', /^\/skill:address-feedback /);
});

test('given any revision, when pi starts, then its fixed instruction tells it to ask on the pull request and end its run without waiting, and does not say that no human will answer', async () => {
  const { pi } = await revise();

  assert.ok(pi);
  const instructions = pi.argv.filter((_, index) => pi.argv[index - 1] === '--append-system-prompt');
  const revision = instructions.find((text) => text.includes('reply on the pull request'));
  assert.match(revision ?? '', /end your run at once, without waiting or polling for an answer/);
  assert.equal(instructions.some((text) => text.includes('no human will answer')), false);
  assert.equal(instructions.includes(UNATTENDED_INSTRUCTION), false);
});

test('given a revision that ends ok, when it is recorded, then it is against its pull request and run and linked to the dispatch that opened the pull request', async () => {
  const { code, runs, revisions } = await revise({
    seed: (store) => {
      const start = store.startDispatch(
        { repository: 'forge', number: 113, url: 'https://github.com/rameezk/forge/issues/113' },
        'opening-run',
        '2026-09-21T10:00:00.000Z',
        10,
      );
      assert.ok('started' in start);
      store.endDispatch(
        start.started,
        { state: 'done', pullRequest: { number: 143, url: PULL_REQUEST_URL } },
        '2026-09-21T10:30:00.000Z',
      );
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(
    revisions.map(({ repository, number, url, runId, dispatchId, state }) => ({
      repository, number, url, runId, dispatchId, state,
    })),
    [{ repository: 'forge', number: 143, url: PULL_REQUEST_URL, runId: runs[0]?.id, dispatchId: 1, state: 'ok' }],
  );
});

test('given the dispatch that opened the pull request is still running, when forge-revise runs, then no workload starts and the command says why', async () => {
  const { code, pi, revisions, complaints } = await revise({
    seed: (store) => {
      const start = store.startDispatch(
        { repository: 'forge', number: 113, url: 'https://github.com/rameezk/forge/issues/113' },
        'opening-run',
        new Date().toISOString(),
        10,
      );
      assert.ok('started' in start);
    },
  });

  assert.equal(code, 1);
  assert.equal(pi, null);
  assert.deepEqual(revisions, []);
  assert.equal(complaints, 'forge#143 cannot be revised: the dispatch that opened it is still running');
});

test('given a live revision of the pull request, when forge-revise runs, then no second workload starts and the command says why', async () => {
  const { code, pi, revisions, complaints } = await revise({
    seed: (store) => {
      const start = store.startRevision(
        { repository: 'forge', number: 143, url: PULL_REQUEST_URL },
        [],
        'earlier-run',
        new Date().toISOString(),
        10,
      );
      assert.ok('started' in start);
    },
  });

  assert.equal(code, 1);
  assert.equal(pi, null);
  assert.equal(revisions.length, 1);
  assert.equal(complaints, 'forge#143 cannot be revised: a revision of it is already running');
});

test('given dispatch.maxConcurrent workloads already live, when forge-revise runs, then no workload starts until a slot frees', async () => {
  const { code, pi, complaints } = await revise({
    maxConcurrent: 1,
    seed: (store) => {
      const start = store.startDispatch(
        { repository: 'forge', number: 7, url: 'https://github.com/rameezk/forge/issues/7' },
        'other-run',
        new Date().toISOString(),
        1,
      );
      assert.ok('started' in start);
    },
  });

  assert.equal(code, 1);
  assert.equal(pi, null);
  assert.match(complaints, /^forge#143 cannot be revised: 1 workload is already running/);
});

test('given a live revision of another pull request filling dispatch.maxConcurrent, when forge-revise runs, then no workload starts', async () => {
  const { code, pi, complaints } = await revise({
    maxConcurrent: 1,
    seed: (store) => {
      const start = store.startRevision(
        { repository: 'forge', number: 99, url: 'https://github.com/rameezk/forge/pull/99' },
        [],
        'other-run',
        new Date().toISOString(),
        1,
      );
      assert.ok('started' in start);
    },
  });

  assert.equal(code, 1);
  assert.equal(pi, null);
  assert.match(complaints, /^forge#143 cannot be revised: 1 workload is already running/);
});
