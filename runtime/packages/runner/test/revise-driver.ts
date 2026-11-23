import type { LifecycleKind, LifecycleScenario } from './lifecycle.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store, type RevisionRecord, type RunRecord } from '@forge/shared';
import { createApp, FileTranscriptSource } from '@forge/frontend';
import { main } from '../src/revise-main.ts';
import { APP_ID, fakeGithubApp, routedThrough, sentWith, APP_SLUG } from '../../shared/test/fixtures/fake-github-app.ts';
import { billedAt, git, gitConfigOf, fakeOpenRouter, lockedPiPackage, PI_EXTENSIONS, writeFakeBwrap, writeFakePi, brokerEnv } from './helpers.ts';

export const GITHUB_FIXTURES = join(import.meta.dirname, 'fixtures', 'github');

export const PI_OUTPUT = join(import.meta.dirname, 'fixtures', 'pi', 'success.jsonl');

export const PULL_REQUEST_URL = 'https://github.com/rameezk/forge/pull/143';


export interface PullRequestResponse {
  data: {
    repository: {
      pullRequest: {
        state: string;
        isCrossRepository: boolean;
        headRefName: string;
        headRefOid: string;
        closingIssuesReferences: { nodes: { number: number }[] };
      } | null;
    };
  };
}

export const pullRequestFixture = (): PullRequestResponse =>
  JSON.parse(
    readFileSync(join(GITHUB_FIXTURES, 'pull-request.json'), 'utf8'),
  ) as PullRequestResponse;

export const withHead = (response: PullRequestResponse, headRefOid: string): PullRequestResponse => {
  const copy = structuredClone(response);
  copy.data.repository.pullRequest!.headRefOid = headRefOid;
  return copy;
};

export const pushedHeadsOf = (database: string, table: 'revisions' | 'conflict_resolutions'): (string | null)[] => {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    return (db.prepare(`SELECT pushed_sha FROM ${table} ORDER BY id`).all() as { pushed_sha: string | null }[]).map(
      ({ pushed_sha }) => pushed_sha,
    );
  } finally {
    db.close();
  }
};

export const SKILL =
  '---\nname: address-feedback\ndescription: Address review feedback on a pull request.\n---\n\nAddress it.\n';

export interface Origin {
  path: string;
  mainTip: string;
  featureTip: string;
}

export const originWith = (featureFiles: Record<string, string>): Origin => {
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

export interface PiCall {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface Actor {
  __typename: string;
  login: string;
}

export interface Authored {
  url: string;
  author: Actor | null;
  body: string;
}

export interface FeedbackWindowResponse {
  data: {
    repository: {
      pullRequest: {
        reviews: {
          nodes: (Authored & {
            submittedAt: string;
            comments: { nodes: (Authored & { createdAt: string; path: string; line: number | null })[] };
          })[];
        };
        comments: { nodes: (Authored & { createdAt: string })[] };
      };
    };
  };
}

export const OWNER: Actor = { __typename: 'User', login: 'rameezk' };

export const acknowledgeable = <Node extends { url: string }>(node: Node) => ({
  ...node,
  id: node.url,
  reactionGroups: [],
});

export const feedbackWindow = (
  window: {
    reviews?: FeedbackWindowResponse['data']['repository']['pullRequest']['reviews']['nodes'];
    comments?: FeedbackWindowResponse['data']['repository']['pullRequest']['comments']['nodes'];
  } = {},
): FeedbackWindowResponse => ({
  data: {
    repository: {
      pullRequest: {
        reviews: {
          nodes: (window.reviews ?? []).map((review) => ({
            ...acknowledgeable(review),
            comments: { nodes: review.comments.nodes.map(acknowledgeable) },
          })),
        },
        comments: { nodes: (window.comments ?? []).map(acknowledgeable) },
      },
    },
  },
});

export const conversationComment = (
  overrides: Partial<Authored & { createdAt: string }> = {},
): Authored & { createdAt: string } => ({
  url: `${PULL_REQUEST_URL}#issuecomment-1`,
  author: OWNER,
  body: 'Please rename the helper.',
  createdAt: '2026-09-22T10:00:00Z',
  ...overrides,
});

export interface ReactionGroup {
  content: string;
  reactedBy: Actor | null;
}

export interface Reacted {
  reactionGroups: ReactionGroup[];
}

export interface FeedbackAnswersResponse {
  data: {
    repository: {
      pullRequest: {
        reviews: { nodes: ({ url: string } & Reacted)[] };
        reviewThreads: {
          nodes: {
            comments: {
              nodes: ({ url: string; author: Actor | null; createdAt: string } & Reacted)[];
            };
          }[];
        };
        comments: {
          nodes: ({ url: string; body: string; author: Actor | null; createdAt: string } & Reacted)[];
        };
      };
    };
  };
}

export const FORGE_APP: Actor = { __typename: 'Bot', login: APP_SLUG };

export const reactedWith = (content: string, reactor: Actor = FORGE_APP): Reacted => ({
  reactionGroups: [{ content, reactedBy: reactor }],
});

export const thumbsUp = (reactor: Actor = FORGE_APP): Reacted => reactedWith('THUMBS_UP', reactor);

export const noReactions: Reacted = {
  reactionGroups: [{ content: 'THUMBS_UP', reactedBy: null }],
};

export const viewedBy = (value: unknown, viewer: Actor | null): unknown => {
  if (Array.isArray(value)) return value.map((entry) => viewedBy(entry, viewer));
  if (value === null || typeof value !== 'object') return value;
  if ('reactedBy' in value) {
    const { content, reactedBy } = value as ReactionGroup;
    return { content, viewerHasReacted: reactedBy !== null && reactedBy.login === viewer?.login };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, viewedBy(entry, viewer)]),
  );
};

export const feedbackAnswers = (
  after: {
    reviews?: FeedbackAnswersResponse['data']['repository']['pullRequest']['reviews']['nodes'];
    threads?: FeedbackAnswersResponse['data']['repository']['pullRequest']['reviewThreads']['nodes'];
    comments?: FeedbackAnswersResponse['data']['repository']['pullRequest']['comments']['nodes'];
  } = {},
): FeedbackAnswersResponse => ({
  data: {
    repository: {
      pullRequest: {
        reviews: { nodes: after.reviews ?? [] },
        reviewThreads: { nodes: after.threads ?? [] },
        comments: { nodes: after.comments ?? [] },
      },
    },
  },
});

export const repliedBy = (author: Actor, createdAt = '2026-09-22T11:00:00Z') => ({
  url: `${PULL_REQUEST_URL}#discussion_r10`,
  author,
  createdAt,
  ...noReactions,
});

export const instructionOf = (pi: PiCall | null): string =>
  (pi?.argv ?? [])
    .filter((_, index) => pi?.argv[index - 1] === '--append-system-prompt')
    .join('\n');

export const userMessageOf = (pi: PiCall | null): string => pi?.argv.at(-1) ?? '';

export interface FeedbackAnswersRejection {
  data?: FeedbackAnswersResponse['data'] | { repository: { pullRequest: null } };
  errors: { message: string }[];
}

export interface Scenario {
  origin?: Origin;
  feedback?: FeedbackWindowResponse | FeedbackAnswersRejection;
  answers?: FeedbackAnswersResponse | FeedbackAnswersRejection;
  prompt?: string;
  pullRequest?: PullRequestResponse;
  seed?: (store: Store) => void;
  maxConcurrent?: number;
  botLookupFails?: boolean;
  permissions?: Record<string, string>;
  piPackage?: string;
  timeoutSeconds?: number;
  piLingerMs?: number;
  viewerKind?: 'read' | 'write';
  hangingClone?: boolean;
  setupTimeoutSeconds?: number;
  pushedHead?: string;
  failingQuery?: string;
}

export interface Outcome {
  code: number;
  origin: Origin;
  runs: RunRecord[];
  revisions: RevisionRecord[];
  pushedHeads: (string | null)[];
  complaints: string;
  pi: PiCall | null;
  gitConfig: Record<string, string>;
  runsList: string;
  thrown: string | null;
  nextAfter: string | null;
}

export const botLookupRejected =
  (next: typeof globalThis.fetch): typeof globalThis.fetch =>
  async (input, init) =>
    /^\/users\/[^/]+(\[bot\]|%5Bbot%5D)$/.test(new URL(String(input)).pathname)
      ? new Response(JSON.stringify({ message: 'Bad credentials' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      : next(input, init);

export const nextRevisionAfter = (store: Store): string | null => {
  const next = store.workloads.startRevision(
    { repository: 'forge', number: 143, url: PULL_REQUEST_URL },
    [],
    'next-run',
    new Date(Date.now() + 60_000).toISOString(),
    10,
  );
  return 'started' in next ? next.after : null;
};

export const hangingCloneGit = (dir: string): string => {
  const bin = join(dir, 'git-hanging-clone');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\ncase " $* " in *" clone "*) sleep 300 & wait;; esac\nexec git-real "$@"\n`.replace(
      'git-real',
      execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(),
    ),
  );
  chmodSync(join(bin, 'git'), 0o755);
  return bin;
};

export const revise = async (scenario: Scenario = {}): Promise<Outcome> => {
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
          ...(scenario.timeoutSeconds === undefined ? {} : { timeoutSeconds: scenario.timeoutSeconds }),
        },
      },
      repositories: {
        forge: { github: 'rameezk/forge', on: { feedback: 'reviser' } },
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
  const pullRequest = scenario.pullRequest ?? pullRequestFixture();
  let headReads = 0;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const { pathname } = new URL(String(input));
    const lookup = /^\/repos\/rameezk\/forge\/collaborators\/([^/]+)\/permission$/.exec(pathname);
    if (lookup !== null) {
      const permission = { rameezk: 'admin', ...scenario.permissions }[
        decodeURIComponent(lookup[1] as string)
      ];
      return permission === undefined
        ? new Response('{}', { status: 404 })
        : new Response(JSON.stringify({ permission }), {
            headers: { 'content-type': 'application/json' },
          });
    }
    assert.equal(pathname, '/graphql');
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    const viewer = sentWith(init, scenario.viewerKind ?? 'read') ? FORGE_APP : null;
    if (scenario.failingQuery !== undefined && query.includes(scenario.failingQuery)) {
      throw new Error('GitHub is down');
    }
    if (query.includes('query PullRequestHead')) headReads += 1;
    const answer = query.includes('query FeedbackWindow')
      ? scenario.feedback ?? feedbackWindow({ comments: [conversationComment()] })
      : query.includes('query FeedbackAnswers')
        ? scenario.answers ??
          feedbackAnswers({
            comments: [{ ...conversationComment(), ...thumbsUp() }],
          })
        : scenario.pushedHead !== undefined && headReads > 1
          ? withHead(pullRequest, scenario.pushedHead)
          : pullRequest;
    return new Response(JSON.stringify(viewedBy(answer, viewer)), {
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
      PATH: scenario.hangingClone === true ? `${hangingCloneGit(stateDir)}:${process.env.PATH}` : process.env.PATH,
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
          ...(scenario.piLingerMs === undefined ? {} : { FAKE_PI_LINGER_MS: String(scenario.piLingerMs) }),
        },
      }),
      FORGE_GITHUB_APP_ID: APP_ID,
      FORGE_GITHUB_APP_PRIVATE_KEY_FILE: privateKeyFile,
      OPENROUTER_API_KEY: 'sk-or-test',
      OPENROUTER_BASE_URL: openRouter.baseUrl,
      ...gitConfig,
    },
    scenario.botLookupFails === true ? botLookupRejected(routedThrough(app, fetch)) : routedThrough(app, fetch),
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
    return {
      code,
      origin,
      runs: store.runs.listRuns(),
      revisions: store.workloads.listRevisions(new Date().toISOString()),
      pushedHeads: pushedHeadsOf(join(stateDir, 'forge.db'), 'revisions'),
      complaints: complaints.join('\n'),
      pi: existsSync(record) ? (JSON.parse(readFileSync(record, 'utf8')) as PiCall) : null,
      gitConfig,
      thrown,
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
      nextAfter: nextRevisionAfter(store),
    };
  } finally {
    store.close();
  }
};

const lifecycleScenarioOf = (scenario: LifecycleScenario): Scenario => {
  const pullRequest = pullRequestFixture();
  if (scenario.closed === true) pullRequest.data.repository.pullRequest!.state = 'CLOSED';
  if (scenario.fromFork === true) pullRequest.data.repository.pullRequest!.isCrossRepository = true;
  return {
    pullRequest,
    ...(scenario.seed === undefined ? {} : { seed: scenario.seed }),
    ...(scenario.maxConcurrent === undefined ? {} : { maxConcurrent: scenario.maxConcurrent }),
    ...(scenario.botLookupFails === true ? { botLookupFails: true } : {}),
    ...(scenario.headQueryFails === true ? { failingQuery: 'query PullRequestHead' } : {}),
    ...(scenario.checkFails === true ? { failingQuery: 'query FeedbackAnswers' } : {}),
    ...(scenario.beforeFails === true
      ? {
          feedback: {
            data: { repository: { pullRequest: null } },
            errors: [{ message: 'Window query rejected' }],
          },
        }
      : {}),
    ...(scenario.launchThrows === true
      ? { piPackage: join(tmpdir(), 'forge-missing-pi-package') }
      : {}),
    ...(scenario.hangingClone === true ? { hangingClone: true } : {}),
    ...(scenario.setupTimeoutSeconds === undefined
      ? {}
      : { setupTimeoutSeconds: scenario.setupTimeoutSeconds }),
    ...(scenario.pushedHead === undefined ? {} : { pushedHead: scenario.pushedHead }),
    ...(scenario.exceeds === true ? { piLingerMs: 10_000, timeoutSeconds: 1 } : {}),
  };
};

export const revisionLifecycle: LifecycleKind = {
  name: 'revision',
  command: 'forge-revise',
  main,
  earlierFailedStart: (store) =>
    store.workloads.recordRevisionStartFailure(
      { repository: 'forge', number: 143, url: PULL_REQUEST_URL },
      'earlier',
      new Date(Date.now() - 60_000).toISOString(),
    ),
  refusal: 'cannot be revised',
  livePullRequest: (store) => {
    const start = store.workloads.startRevision(
      { repository: 'forge', number: 143, url: PULL_REQUEST_URL },
      [],
      'earlier-run',
      new Date().toISOString(),
      10,
    );
    assert.ok('started' in start);
  },
  extraPrepareFailures: [],
  run: async (scenario) => {
    const outcome = await revise(lifecycleScenarioOf(scenario));
    return {
      code: outcome.code,
      thrown: outcome.thrown,
      complaints: outcome.complaints,
      harnessStarted: outcome.pi !== null,
      runs: outcome.runs.map(({ id, status, error }) => ({ id, status, error })),
      workloads: outcome.revisions.map(({ runId, state, reason, detail, failedStarts }) => ({
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
