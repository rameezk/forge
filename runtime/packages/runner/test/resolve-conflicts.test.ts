import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  Store,
  type ConflictResolutionRecord,
  type RunRecord,
} from '@forge/shared';
import { createApp, FileTranscriptSource } from '@forge/frontend';
import { main } from '../src/resolve-conflicts-main.ts';
import { textOf } from '../../frontend/test/html.ts';
import {
  APP_ID,
  fakeGithubApp,
  routedThrough,
} from '../../shared/test/fixtures/fake-github-app.ts';
import {
  billedAt,
  fakeOpenRouter,
  git,
  gitConfigOf,
  lockedPiPackage,
  PI_EXTENSIONS,
  writeFakeBwrap,
  writeFakePi,
} from './helpers.ts';

const PI_OUTPUT = join(import.meta.dirname, 'fixtures', 'pi', 'success.jsonl');

const PULL_REQUEST_URL = 'https://github.com/rameezk/forge/pull/143';

const SKILL =
  '---\nname: git-pr-resolve-conflicts\ndescription: Resolve merge conflicts on a pull request.\n---\n\nResolve them.\n';

interface Origin {
  path: string;
  mainTip: string;
  featureTip: string;
}

const commitAll = (path: string, message: string, files: Record<string, string>): string => {
  for (const [file, contents] of Object.entries(files)) {
    writeFileSync(join(path, file), contents);
  }
  git(path, 'add', '.');
  git(path, 'commit', '--quiet', '-m', message);
  return git(path, 'rev-parse', 'HEAD');
};

const originWhere = (defaultBranch: 'conflicts' | 'merges cleanly'): Origin => {
  const path = mkdtempSync(join(tmpdir(), 'forge-origin-'));
  git(path, 'init', '--quiet', '--initial-branch', 'main');
  git(path, 'config', 'uploadpack.allowFilter', 'true');
  git(path, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  mkdirSync(join(path, '.claude', 'skills', 'git-pr-resolve-conflicts'), { recursive: true });
  writeFileSync(join(path, '.claude', 'skills', 'git-pr-resolve-conflicts', 'SKILL.md'), SKILL);
  commitAll(path, 'base', { 'a.txt': 'base\n', 'b.txt': 'base\n' });
  git(path, 'switch', '--quiet', '-c', 'feature');
  const featureTip = commitAll(path, 'feature', { 'a.txt': 'feature\n', 'b.txt': 'feature\n' });
  git(path, 'switch', '--quiet', 'main');
  const mainTip =
    defaultBranch === 'conflicts'
      ? commitAll(path, 'main', { 'a.txt': 'main\n', 'b.txt': 'main\n' })
      : commitAll(path, 'main', { 'c.txt': 'main\n' });
  return { path, mainTip, featureTip };
};

interface PiCall {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

interface PullRequestState {
  state: string;
  isCrossRepository: boolean;
}

interface Scenario {
  origin?: Origin;
  worker?: (origin: Origin) => string;
  mergeable?: string;
  pullRequest?: Partial<PullRequestState>;
  harnessEnv?: Record<string, string>;
  maxConcurrent?: number;
  seed?: (store: Store) => void;
}

interface Outcome {
  code: number;
  origin: Origin;
  runs: RunRecord[];
  resolutions: ConflictResolutionRecord[];
  complaints: string;
  pi: PiCall | null;
  transcript: string;
  requests: string[];
  runsList: string;
  thrown: string | null;
}

const conflictsWith = (origin: Origin, target: string): boolean => {
  try {
    execFileSync('git', ['merge-tree', '--write-tree', 'feature', target], {
      cwd: origin.path,
      stdio: 'ignore',
    });
    return false;
  } catch {
    return true;
  }
};

const resolve = async (scenario: Scenario = {}): Promise<Outcome> => {
  const origin = scenario.origin ?? originWhere('conflicts');
  const stateDir = mkdtempSync(join(tmpdir(), 'forge-resolve-conflicts-'));
  const record = join(stateDir, 'pi-call.json');
  const configPath = join(stateDir, 'runtime.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      harnesses: { pi: { command: writeFakePi(stateDir) } },
      workers: {
        resolver: {
          harness: 'pi',
          model: 'z-ai/glm-5',
          prompt: '/git-pr-resolve-conflicts {url}',
        },
      },
      repositories: {
        forge: { github: 'rameezk/forge', on: { conflict: 'resolver' } },
      },
      dispatch: {
        ...(scenario.maxConcurrent === undefined ? {} : { maxConcurrent: scenario.maxConcurrent }),
      },
    }),
  );
  const app = fakeGithubApp(['rameezk/forge']);
  const privateKeyFile = join(stateDir, 'github-app-private-key');
  writeFileSync(privateKeyFile, app.privateKey);
  const requests: string[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    assert.equal(new URL(String(input)).pathname, '/graphql');
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    requests.push(query);
    const answer = query.includes('query PullRequestConflict')
      ? {
          data: {
            repository: {
              defaultBranchRef: {
                name: 'main',
                target: { oid: git(origin.path, 'rev-parse', 'main') },
              },
              pullRequest: {
                mergeable:
                  scenario.mergeable ??
                  (conflictsWith(origin, 'main') ? 'CONFLICTING' : 'MERGEABLE'),
                headRefOid: git(origin.path, 'rev-parse', 'feature'),
                baseRefOid: git(origin.path, 'rev-parse', 'main'),
              },
            },
          },
        }
      : {
          data: {
            repository: {
              pullRequest: {
                number: 143,
                url: PULL_REQUEST_URL,
                state: 'OPEN',
                isCrossRepository: false,
                ...scenario.pullRequest,
                headRefName: 'feature',
                closingIssuesReferences: {
                  nodes: [{ number: 113, repository: { nameWithOwner: 'rameezk/forge' } }],
                },
              },
            },
          },
        };
    return new Response(JSON.stringify(answer), {
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
  let thrown: string | null = null;
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
        harnessEnv: {
          FAKE_PI_RECORD: record,
          FAKE_PI_OUTPUT: PI_OUTPUT,
          ...scenario.harnessEnv,
          ...(scenario.worker === undefined ? {} : { FAKE_PI_ACTION: scenario.worker(origin) }),
        },
      }),
      FORGE_GITHUB_APP_ID: APP_ID,
      FORGE_GITHUB_APP_PRIVATE_KEY_FILE: privateKeyFile,
      OPENROUTER_API_KEY: 'sk-or-test',
      OPENROUTER_BASE_URL: openRouter.baseUrl,
      ...gitConfig,
    },
    routedThrough(app, fetch),
  )
    .catch((error: unknown) => {
      thrown = error instanceof Error ? error.message : String(error);
      return 1;
    })
    .finally(() => {
      console.error = complain;
      return openRouter.close();
    });

  const store = Store.open(join(stateDir, 'forge.db'));
  try {
    const runs = store.listRuns();
    const transcriptRef = runs[0]?.transcriptRef;
    return {
      code,
      origin,
      runs,
      resolutions: store.listConflictResolutions(new Date().toISOString()),
      complaints: complaints.join('\n'),
      pi: existsSync(record) ? (JSON.parse(readFileSync(record, 'utf8')) as PiCall) : null,
      transcript:
        transcriptRef == null
          ? ''
          : readFileSync(join(stateDir, 'transcripts', transcriptRef), 'utf8'),
      requests,
      thrown,
      runsList: await (
        await createApp({
          store,
          transcripts: new FileTranscriptSource(join(stateDir, 'transcripts')),
          css: '',
          logo: '',
          idiomorph: '',
          client: '',
        }).request('/runs')
      ).text(),
    };
  } finally {
    store.close();
  }
};

const reachingOrigin = (origin: Origin): string =>
  `git -c url.${pathToFileURL(origin.path).href}.insteadOf=https://github.com/rameezk/forge.git`;

const mergeAndPush = (origin: Origin): string =>
  `${reachingOrigin(origin)} merge --quiet -X ours --no-edit ${origin.mainTip} && git push --quiet ${origin.path} HEAD:feature`;

test('given a pull request GitHub reports as conflicting whose branch merges the default branch cleanly, when forge-resolve-conflicts runs, then it ends ok without starting the harness, and nothing is pushed', async () => {
  const origin = originWhere('merges cleanly');
  const { code, pi, runs, resolutions } = await resolve({ origin, mergeable: 'CONFLICTING' });

  assert.equal(code, 0);
  assert.equal(pi, null);
  assert.deepEqual(runs, []);
  assert.deepEqual(resolutions.map(({ state }) => state), ['ok']);
  assert.equal(git(origin.path, 'rev-parse', 'feature'), origin.featureTip);
});

test('given a branch that conflicts with the default branch in two files, when forge-resolve-conflicts runs, then the worker is told the pull request, the default branch, the sha to merge and both files, in a prompt the transcript shows', async () => {
  const origin = originWhere('conflicts');
  const { pi, transcript, runs } = await resolve({ origin, worker: mergeAndPush });

  assert.ok(pi);
  const prompt = pi.argv.at(-1) ?? '';
  assert.match(prompt, new RegExp(`^/skill:git-pr-resolve-conflicts ${PULL_REQUEST_URL}\\n`));
  assert.match(prompt, /pull request #143/);
  assert.match(prompt, /default branch main/);
  assert.ok(prompt.includes(origin.mainTip));
  assert.match(prompt, /^- a\.txt$/m);
  assert.match(prompt, /^- b\.txt$/m);
  assert.equal(runs.length, 1);
  assert.ok(transcript.includes(origin.mainTip));
  assert.ok(transcript.includes('a.txt'));
});

const pushEmptyCommit = (origin: Origin): string =>
  `git commit --quiet --allow-empty -m unrelated && git push --quiet ${origin.path} HEAD:feature`;

const moveMainOnThenMerge = (origin: Origin): string =>
  `printf moved > ${origin.path}/a.txt && git -C ${origin.path} -c user.name=T -c user.email=t@example.com commit --quiet --all -m moved && ${mergeAndPush(origin)}`;

test('given a worker that merges the given sha and pushes, when the run ends, then the conflict resolution ends ok and the branch holds the sha', async () => {
  const origin = originWhere('conflicts');
  const { code, resolutions, runs } = await resolve({ origin, worker: mergeAndPush });

  assert.equal(code, 0);
  assert.deepEqual(resolutions.map(({ state, reason }) => ({ state, reason })), [{ state: 'ok', reason: null }]);
  assert.equal(resolutions[0]?.runId, runs[0]?.id);
  assert.equal(git(origin.path, 'merge-base', '--is-ancestor', origin.mainTip, 'feature'), '');
});

test('given a worker that ends successfully without merging the given sha, when the run ends, then the conflict resolution fails, recording that the sha was not merged', async () => {
  const origin = originWhere('conflicts');
  const { code, resolutions, requests } = await resolve({ origin, worker: pushEmptyCommit });

  assert.equal(code, 1);
  assert.deepEqual(resolutions.map(({ state, reason }) => ({ state, reason })), [{ state: 'error', reason: 'not-merged' }]);
  assert.ok(resolutions[0]?.detail?.includes(origin.mainTip));
  assert.equal(requests.some((query) => query.includes('mutation')), false);
});

test('given a worker that pushes but leaves the pull request conflicting with the given sha, when the run ends, then the conflict resolution fails, recording that the pull request still conflicts', async () => {
  const origin = originWhere('conflicts');
  const { code, resolutions } = await resolve({ origin, worker: mergeAndPush, mergeable: 'CONFLICTING' });

  assert.equal(code, 1);
  assert.deepEqual(resolutions.map(({ state, reason }) => ({ state, reason })), [{ state: 'error', reason: 'still-conflicting' }]);
  assert.ok(resolutions[0]?.detail?.includes(origin.mainTip));
});

test('given the default branch gains a conflicting commit while the conflict resolution runs, and the worker merges the sha it was given, when the run ends, then the conflict resolution ends ok', async () => {
  const origin = originWhere('conflicts');
  const { code, resolutions } = await resolve({ origin, worker: moveMainOnThenMerge });

  assert.equal(code, 0);
  assert.deepEqual(resolutions.map(({ state }) => state), ['ok']);
  assert.notEqual(git(origin.path, 'rev-parse', 'main'), origin.mainTip);
});

test('given a harness that fails, when the conflict resolution ends, then it ends in error and the pull request is left untouched', async () => {
  const { code, resolutions, runs, requests } = await resolve({ harnessEnv: { FAKE_PI_EXIT: '1' } });

  assert.equal(code, 1);
  assert.deepEqual(resolutions.map(({ state }) => state), ['error']);
  assert.equal(runs[0]?.status, 'error');
  assert.equal(requests.some((query) => query.includes('mutation')), false);
});

const OPEN_ELSEWHERE = { repository: 'forge', url: PULL_REQUEST_URL };

const refusals: [string, Scenario, RegExp][] = [
  ['closed', { pullRequest: { state: 'CLOSED' } }, /it is not open/],
  ['from a fork', { pullRequest: { isCrossRepository: true } }, /its branch is on a fork/],
  [
    'with a live dispatch of the ticket that opened it',
    {
      seed: (store) => {
        const start = store.startDispatch(
          { repository: 'forge', number: 113, url: 'https://github.com/rameezk/forge/issues/113' },
          'opening-run',
          new Date().toISOString(),
          10,
        );
        assert.ok('started' in start);
      },
    },
    /the dispatch that opened it is still running/,
  ],
  [
    'with a live revision',
    {
      seed: (store) => {
        const start = store.startRevision({ ...OPEN_ELSEWHERE, number: 143 }, [], 'earlier', new Date().toISOString(), 10);
        assert.ok('started' in start);
      },
    },
    /a revision of it is already running/,
  ],
  [
    'with a live conflict resolution',
    {
      seed: (store) => {
        const start = store.startConflictResolution({ ...OPEN_ELSEWHERE, number: 143 }, [], 'earlier', new Date().toISOString(), 10);
        assert.ok('started' in start);
      },
    },
    /a conflict resolution of it is already running/,
  ],
  [
    'while the pool is full',
    {
      maxConcurrent: 1,
      seed: (store) => {
        const start = store.startRevision({ ...OPEN_ELSEWHERE, number: 99 }, [], 'other', new Date().toISOString(), 1);
        assert.ok('started' in start);
      },
    },
    /1 workload is already running, the most forge\.runtime\.dispatch\.maxConcurrent allows/,
  ],
];

for (const [what, scenario, reason] of refusals) {
  test(`given a pull request ${what}, when forge-resolve-conflicts runs, then it is refused before the harness starts and the command says why`, async () => {
    const { code, pi, runs, complaints } = await resolve(scenario);

    assert.equal(code, 1);
    assert.equal(pi, null);
    assert.deepEqual(runs, []);
    assert.match(complaints, /^forge#143 cannot have its conflicts resolved: /);
    assert.match(complaints, reason);
  });
}

test('given a conflict resolution that ran, when the runs list is rendered, then its run shows against its pull request', async () => {
  const { runsList } = await resolve({ worker: mergeAndPush });

  const row = /<tr[^>]*data-run="[^"]*"[^>]*>[\s\S]*?<\/tr>/.exec(runsList)?.[0] ?? '';
  assert.match(textOf(row), /forge PR #143/);
});
