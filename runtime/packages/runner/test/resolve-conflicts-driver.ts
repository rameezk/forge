import type { LifecycleKind, LifecycleScenario } from './lifecycle.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store, type ConflictResolutionRecord, type RunRecord } from '@forge/shared';
import { createApp, FileTranscriptSource } from '@forge/frontend';
import { main } from '../src/resolve-conflicts-main.ts';
import { APP_ID, fakeGithubApp, type FakeGithubApp, routedThrough } from '../../shared/test/fixtures/fake-github-app.ts';
import { billedAt, fakeOpenRouter, git, gitConfigOf, lockedPiPackage, PI_EXTENSIONS, writeFakeBwrap, writeFakePi, brokerEnv } from './helpers.ts';

export const PI_OUTPUT = join(import.meta.dirname, 'fixtures', 'pi', 'success.jsonl');

export const PULL_REQUEST_URL = 'https://github.com/rameezk/forge/pull/143';

export const SKILL =
  '---\nname: git-pr-resolve-conflicts\ndescription: Resolve merge conflicts on a pull request.\n---\n\nResolve them.\n';

export interface Origin {
  path: string;
  mainTip: string;
  featureTip: string;
}

export const commitAll = (path: string, message: string, files: Record<string, string>): string => {
  for (const [file, contents] of Object.entries(files)) {
    writeFileSync(join(path, file), contents);
  }
  git(path, 'add', '.');
  git(path, 'commit', '--quiet', '-m', message);
  return git(path, 'rev-parse', 'HEAD');
};

export const originWhere = (defaultBranch: 'conflicts' | 'merges cleanly'): Origin => {
  const path = mkdtempSync(join(tmpdir(), 'forge-origin-'));
  git(path, 'init', '--quiet', '--initial-branch', 'main');
  git(path, 'config', 'uploadpack.allowFilter', 'true');
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

export interface PiCall {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface PullRequestState {
  state: string;
  isCrossRepository: boolean;
}

export interface CheckContext {
  __typename: 'CheckRun';
  name: string;
  status: string;
  conclusion: string | null;
  isRequired: boolean;
}

export const checkRun = (name: string, conclusion: string | null, isRequired = true): CheckContext => ({
  __typename: 'CheckRun',
  name,
  status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED',
  conclusion,
  isRequired,
});

export const pushedHeadsOf = (database: string): (string | null)[] => {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    return (
      db.prepare('SELECT pushed_sha FROM conflict_resolutions ORDER BY id').all() as { pushed_sha: string | null }[]
    ).map(({ pushed_sha }) => pushed_sha);
  } finally {
    db.close();
  }
};

export interface Scenario {
  origin?: Origin;
  checks?: CheckContext[] | null;
  worker?: (origin: Origin) => string;
  mergeable?: string[];
  failingQuery?: string;
  botLookupFails?: boolean;
  failingClone?: number;
  hangingTrialMerge?: boolean;
  hangingWorkerClone?: boolean;
  setupTimeoutSeconds?: number;
  pullRequest?: Partial<PullRequestState>;
  harnessEnv?: Record<string, string>;
  maxConcurrent?: number;
  seed?: (store: Store) => void;
  piPackage?: string;
  timeoutSeconds?: number;
  pushedHead?: string;
}

export interface Outcome {
  code: number;
  app: FakeGithubApp;
  origin: Origin;
  runs: RunRecord[];
  resolutions: ConflictResolutionRecord[];
  pushedHeads: (string | null)[];
  complaints: string;
  pi: PiCall | null;
  transcript: string;
  clones: string[];
  requests: string[];
  pauses: number[];
  runsList: string;
  thrown: string | null;
  hungChild: number | null;
}

export const conflictsWith = (origin: Origin, target: string): boolean => {
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

export const recordingGit = (
  dir: string,
  failingClone: number | undefined,
  hangingTrialMerge: boolean,
  hangingWorkerClone: boolean,
): { bin: string; log: string; hung: string } => {
  const bin = join(dir, 'git-recorder');
  const log = join(dir, 'git-calls.log');
  const hung = join(dir, 'hung-child.pid');
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n${
      failingClone === undefined
        ? ''
        : `case " $* " in *" clone "*) [ "$(grep -cE '(^| )clone ' '${log}')" -ge ${failingClone} ] && { echo 'fatal: unable to access the repository' >&2; exit 128; };; esac\n`
    }${
      hangingWorkerClone
        ? `case " $* " in *" clone "*) [ "$(grep -cE '(^| )clone ' '${log}')" -ge 2 ] && { sleep 300 & wait; };; esac\n`
        : ''
    }${
      hangingTrialMerge
        ? `case " $* " in *" merge --no-commit "*) sleep 300 & echo $! > '${hung}'; wait;; esac\n`
        : ''
    }exec '${real}' "$@"\n`,
  );
  chmodSync(join(bin, 'git'), 0o755);
  return { bin, log, hung };
};

export const botLookupRejected =
  (next: typeof globalThis.fetch): typeof globalThis.fetch =>
  async (input, init) =>
    /^\/users\/[^/]+(\[bot\]|%5Bbot%5D)$/.test(new URL(String(input)).pathname)
      ? new Response(JSON.stringify({ message: 'Bad credentials' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      : next(input, init);

export const resolve = async (scenario: Scenario = {}): Promise<Outcome> => {
  const origin = scenario.origin ?? originWhere('conflicts');
  const stateDir = mkdtempSync(join(tmpdir(), 'forge-resolve-conflicts-'));
  const recorder = recordingGit(stateDir, scenario.failingClone, scenario.hangingTrialMerge === true, scenario.hangingWorkerClone === true);
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
          ...(scenario.timeoutSeconds === undefined ? {} : { timeoutSeconds: scenario.timeoutSeconds }),
        },
      },
      repositories: {
        forge: { github: 'rameezk/forge', on: { conflict: 'resolver' } },
      },
      ...(scenario.setupTimeoutSeconds === undefined
        ? {}
        : { workload: { setupTimeoutSeconds: scenario.setupTimeoutSeconds } }),
      dispatch: {
        ...(scenario.maxConcurrent === undefined ? {} : { maxConcurrent: scenario.maxConcurrent }),
      },
    }),
  );
  const app = fakeGithubApp(['rameezk/forge']);
  const privateKeyFile = join(stateDir, 'github-app-private-key');
  writeFileSync(privateKeyFile, app.privateKey);
  const requests: string[] = [];
  const pauses: number[] = [];
  let conflictReads = 0;
  let headReads = 0;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    assert.equal(new URL(String(input)).pathname, '/graphql');
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    requests.push(query);
    if (scenario.failingQuery !== undefined && query.includes(scenario.failingQuery)) {
      throw new Error('GitHub is down');
    }
    if (query.includes('query PullRequestConflict')) conflictReads += 1;
    if (query.includes('query PullRequestHead')) headReads += 1;
    const answer = query.includes('query PullRequestReadiness')
      ? {
          data: {
            repository: {
              pullRequest: {
                isDraft: false,
                commits: {
                  nodes: [
                    {
                      commit: {
                        statusCheckRollup:
                          scenario.checks === null
                            ? null
                            : {
                                contexts: {
                                  pageInfo: { hasNextPage: false },
                                  nodes: scenario.checks ?? [],
                                },
                              },
                      },
                    },
                  ],
                },
              },
            },
          },
        }
      : query.includes('query PullRequestConflict')
      ? {
          data: {
            repository: {
              defaultBranchRef: {
                name: 'main',
                target: { oid: git(origin.path, 'rev-parse', 'main') },
              },
              pullRequest: {
                mergeable:
                  scenario.mergeable?.[Math.min(conflictReads - 1, scenario.mergeable.length - 1)] ??
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
                headRefOid:
                  scenario.pushedHead !== undefined && headReads > 1
                    ? scenario.pushedHead
                    : origin.featureTip,
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
      PATH: `${recorder.bin}:${process.env.PATH}`,
      HOME: stateDir,
      FORGE_NIX_SYSTEM: 'x86_64-linux',
      FORGE_RUNTIME_CONFIG: configPath,
      FORGE_STATE_DIR: stateDir,
      FORGE_PI_SUBAGENT_EXTENSION: PI_EXTENSIONS.subagent,
      FORGE_PI_MODEL_DEFAULT_REASONING_EXTENSION: PI_EXTENSIONS.modelDefaultReasoning,
      FORGE_PI_REQUEST_RECORD_EXTENSION: PI_EXTENSIONS.requestRecord,
      FORGE_PI_PACKAGE: scenario.piPackage ?? lockedPiPackage(),
      ...brokerEnv(stateDir),
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
    scenario.botLookupFails === true ? botLookupRejected(routedThrough(app, fetch)) : routedThrough(app, fetch),
    async (ms) => {
      pauses.push(ms);
    },
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
      app,
      origin,
      runs,
      resolutions: store.listConflictResolutions(new Date().toISOString()),
      pushedHeads: pushedHeadsOf(join(stateDir, 'forge.db')),
      complaints: complaints.join('\n'),
      pi: existsSync(record) ? (JSON.parse(readFileSync(record, 'utf8')) as PiCall) : null,
      transcript:
        transcriptRef == null
          ? ''
          : readFileSync(join(stateDir, 'transcripts', transcriptRef), 'utf8'),
      clones: existsSync(recorder.log)
        ? readFileSync(recorder.log, 'utf8')
            .split('\n')
            .filter((call) => / clone /.test(` ${call} `))
        : [],
      requests,
      pauses,
      thrown,
      hungChild: existsSync(recorder.hung) ? Number(readFileSync(recorder.hung, 'utf8')) : null,
      runsList: await (
        await createApp({
          store,
          transcripts: new FileTranscriptSource(join(stateDir, 'transcripts')),
          css: '',
          logo: '',
          idiomorph: '',
          client: '',
        }).request('/workloads')
      ).text(),
    };
  } finally {
    store.close();
  }
};

export const reachingOrigin = (origin: Origin): string =>
  `git -c url.${pathToFileURL(origin.path).href}.insteadOf=https://github.com/rameezk/forge.git`;

export const mergeAndPush = (origin: Origin): string =>
  `${reachingOrigin(origin)} merge --quiet -X ours --no-edit ${origin.mainTip} && git push --quiet ${origin.path} HEAD:feature`;

const resolveScenarioOf = (scenario: LifecycleScenario): Scenario => ({
  worker: mergeAndPush,
  ...(scenario.seed === undefined ? {} : { seed: scenario.seed }),
  ...(scenario.maxConcurrent === undefined ? {} : { maxConcurrent: scenario.maxConcurrent }),
  pullRequest: {
    ...(scenario.closed === true ? { state: 'CLOSED' } : {}),
    ...(scenario.fromFork === true ? { isCrossRepository: true } : {}),
  },
  ...(scenario.botLookupFails === true ? { botLookupFails: true } : {}),
  ...(scenario.headQueryFails === true ? { failingQuery: 'query PullRequestHead' } : {}),
  ...(scenario.targetQueryFails === true ? { failingQuery: 'query PullRequestConflict' } : {}),
  ...(scenario.checkFails === true ? { failingQuery: 'query PullRequestReadiness' } : {}),
  ...(scenario.beforeFails === true ? { failingClone: 1 } : {}),
  ...(scenario.launchThrows === true
    ? { piPackage: join(tmpdir(), 'forge-missing-pi-package') }
    : {}),
  ...(scenario.hangingClone === true ? { hangingWorkerClone: true } : {}),
  ...(scenario.setupTimeoutSeconds === undefined
    ? {}
    : { setupTimeoutSeconds: scenario.setupTimeoutSeconds }),
  ...(scenario.pushedHead === undefined ? {} : { pushedHead: scenario.pushedHead }),
  ...(scenario.exceeds === true
    ? { harnessEnv: { FAKE_PI_LINGER_MS: '10000' }, timeoutSeconds: 1 }
    : {}),
});

export const conflictResolutionLifecycle: LifecycleKind = {
  name: 'conflict resolution',
  command: 'forge-resolve-conflicts',
  main,
  earlierFailedStart: (store) =>
    store.recordConflictResolutionStartFailure(
      { repository: 'forge', number: 143, url: PULL_REQUEST_URL },
      'earlier',
      new Date(Date.now() - 60_000).toISOString(),
    ),
  refusal: 'cannot have its conflicts resolved',
  livePullRequest: (store) => {
    const start = store.startConflictResolution(
      { repository: 'forge', number: 143, url: PULL_REQUEST_URL },
      [],
      'earlier-run',
      new Date().toISOString(),
      10,
      { headSha: 'head-a', defaultSha: 'default-a' },
    );
    assert.ok('started' in start);
  },
  extraPrepareFailures: [['a conflict target query that fails', { targetQueryFails: true }]],
  run: async (scenario) => {
    const outcome = await resolve(resolveScenarioOf(scenario));
    return {
      code: outcome.code,
      thrown: outcome.thrown,
      complaints: outcome.complaints,
      harnessStarted: outcome.pi !== null,
      runs: outcome.runs.map(({ id, status, error }) => ({ id, status, error })),
      workloads: outcome.resolutions.map(({ runId, state, reason, detail, failedStarts }) => ({
        runId,
        state,
        reason,
        detail,
        failedStarts,
      })),
      pushedHeads: outcome.pushedHeads,
      runsList: outcome.runsList,
    };
  },
};
