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
import { createApp, FileTranscriptSource } from '@forge/frontend';
import { main } from '../src/revise-main.ts';
import { UNATTENDED_INSTRUCTION } from '../src/harness.ts';
import { textOf } from '../../frontend/test/html.ts';
import {
  APP_ID,
  fakeGithubApp,
  routedThrough,
  BOT_EMAIL,
  BOT_LOGIN,
  APP_SLUG,
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

interface Actor {
  __typename: string;
  login: string;
}

interface Authored {
  url: string;
  author: Actor | null;
  authorAssociation: string;
  body: string;
}

interface FeedbackWindowResponse {
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

const OWNER: Actor = { __typename: 'User', login: 'rameezk' };

const feedbackWindow = (
  window: {
    reviews?: FeedbackWindowResponse['data']['repository']['pullRequest']['reviews']['nodes'];
    comments?: FeedbackWindowResponse['data']['repository']['pullRequest']['comments']['nodes'];
  } = {},
): FeedbackWindowResponse => ({
  data: {
    repository: {
      pullRequest: {
        reviews: { nodes: window.reviews ?? [] },
        comments: { nodes: window.comments ?? [] },
      },
    },
  },
});

const conversationComment = (
  overrides: Partial<Authored & { createdAt: string }> = {},
): Authored & { createdAt: string } => ({
  url: `${PULL_REQUEST_URL}#issuecomment-1`,
  author: OWNER,
  authorAssociation: 'OWNER',
  body: 'Please rename the helper.',
  createdAt: '2026-09-22T10:00:00Z',
  ...overrides,
});

interface ReactionGroup {
  content: string;
  reactors: { edges: { reactedAt: string; node: { __typename: string; login: string } }[] };
}

interface Reacted {
  reactionGroups: ReactionGroup[];
}

interface FeedbackAnswersResponse {
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

const FORGE_APP: Actor = { __typename: 'Bot', login: APP_SLUG };

const reactedWith = (
  content: string,
  reactor: Actor = FORGE_APP,
  reactedAt = '2026-09-22T11:00:00Z',
): Reacted => ({
  reactionGroups: [{ content, reactors: { edges: [{ reactedAt, node: reactor }] } }],
});

const thumbsUp = (reactor: Actor = FORGE_APP, reactedAt = '2026-09-22T11:00:00Z'): Reacted =>
  reactedWith('THUMBS_UP', reactor, reactedAt);

const noReactions: Reacted = {
  reactionGroups: [{ content: 'THUMBS_UP', reactors: { edges: [] } }],
};

const feedbackAnswers = (
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

const repliedBy = (author: Actor, createdAt = '2026-09-22T11:00:00Z') => ({
  url: `${PULL_REQUEST_URL}#discussion_r10`,
  author,
  createdAt,
  ...noReactions,
});

const instructionOf = (pi: PiCall | null): string =>
  (pi?.argv ?? [])
    .filter((_, index) => pi?.argv[index - 1] === '--append-system-prompt')
    .join('\n');

interface Scenario {
  origin?: Origin;
  feedback?: FeedbackWindowResponse;
  answers?: FeedbackAnswersResponse;
  prompt?: string;
  pullRequest?: PullRequestResponse;
  seed?: (store: Store) => void;
  maxConcurrent?: number;
  botLookupFails?: boolean;
}

interface Outcome {
  code: number;
  origin: Origin;
  runs: RunRecord[];
  revisions: RevisionRecord[];
  complaints: string;
  pi: PiCall | null;
  gitConfig: Record<string, string>;
  runsList: string;
  thrown: string | null;
}

const gitConfigOf = (entries: Record<string, string>): Record<string, string> =>
  Object.fromEntries([
    ['GIT_CONFIG_COUNT', String(Object.keys(entries).length)],
    ...Object.entries(entries).flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value],
    ]),
  ]);

const botLookupRejected =
  (next: typeof globalThis.fetch): typeof globalThis.fetch =>
  async (input, init) =>
    /^\/users\/[^/]+(\[bot\]|%5Bbot%5D)$/.test(new URL(String(input)).pathname)
      ? new Response(JSON.stringify({ message: 'Bad credentials' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      : next(input, init);

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
        ...(scenario.maxConcurrent === undefined ? {} : { maxConcurrent: scenario.maxConcurrent }),
      },
    }),
  );
  const app = fakeGithubApp(['rameezk/forge']);
  const privateKeyFile = join(stateDir, 'github-app-private-key');
  writeFileSync(privateKeyFile, app.privateKey);
  const pullRequest = scenario.pullRequest ?? pullRequestFixture();
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    assert.equal(new URL(String(input)).pathname, '/graphql');
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    const answer = query.includes('query FeedbackWindow')
      ? scenario.feedback ?? feedbackWindow({ comments: [conversationComment()] })
      : query.includes('query FeedbackAnswers')
        ? scenario.answers ??
          feedbackAnswers({
            comments: [{ ...conversationComment(), ...thumbsUp() }],
          })
        : pullRequest;
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
        harnessEnv: { FAKE_PI_RECORD: record, FAKE_PI_OUTPUT: PI_OUTPUT },
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
      runs: store.listRuns(),
      revisions: store.listRevisions(new Date().toISOString()),
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
        }).request('/runs')
      ).text(),
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
  assert.equal(
    git(origin.path, 'log', '-1', '--format=%an <%ae>%n%cn <%ce>', 'feature'),
    `${BOT_LOGIN} <${BOT_EMAIL}>\n${BOT_LOGIN} <${BOT_EMAIL}>`,
  );
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

const previousRevisionAt = (startedAt: string) => (store: Store) => {
  const start = store.startRevision(
    { repository: 'forge', number: 143, url: PULL_REQUEST_URL },
    [],
    'previous-run',
    startedAt,
    10,
  );
  assert.ok('started' in start);
  store.endRevision(start.started, 'ok', startedAt);
};

test('given a window holding a review summary, an inline review comment and a conversation comment by the owner, when the revision runs, then the instruction lists all three with their kind, author, URL and body, and the inline comment with its file and line', async () => {
  const { pi } = await revise({
    feedback: feedbackWindow({
      reviews: [
        {
          url: `${PULL_REQUEST_URL}#pullrequestreview-7`,
          author: OWNER,
          authorAssociation: 'OWNER',
          body: 'Overall this needs a second look.',
          submittedAt: '2026-09-22T09:00:00Z',
          comments: {
            nodes: [
              {
                url: `${PULL_REQUEST_URL}#discussion_r9`,
                author: OWNER,
                authorAssociation: 'OWNER',
                body: 'This loop is off by one.',
                createdAt: '2026-09-22T09:00:00Z',
                path: 'src/loop.ts',
                line: 42,
              },
            ],
          },
        },
      ],
      comments: [conversationComment()],
    }),
  });

  const instruction = instructionOf(pi);
  assert.match(instruction, /review summary by rameezk: .*#pullrequestreview-7/);
  assert.match(instruction, /Overall this needs a second look\./);
  assert.match(instruction, /inline review comment by rameezk on src\/loop\.ts:42: .*#discussion_r9/);
  assert.match(instruction, /This loop is off by one\./);
  assert.match(instruction, /conversation comment by rameezk: .*#issuecomment-1/);
  assert.match(instruction, /Please rename the helper\./);
  assert.match(instruction, /Address exactly these items and answer each one/);
});

test('given a comment from before the previous revision started and one from after, when the next revision runs, then only the later comment is in the instruction', async () => {
  const { pi } = await revise({
    seed: previousRevisionAt('2026-09-21T10:00:00.000Z'),
    feedback: feedbackWindow({
      comments: [
        conversationComment({ body: 'Already handled earlier.', createdAt: '2026-09-21T09:59:00Z' }),
        conversationComment({ body: 'Newly raised.', createdAt: '2026-09-21T10:01:00Z' }),
      ],
    }),
  });

  const instruction = instructionOf(pi);
  assert.match(instruction, /Newly raised\./);
  assert.doesNotMatch(instruction, /Already handled earlier\./);
});

test('given a window holding a collaborator\'s comment and one by an author with no association, when the revision runs, then only the collaborator\'s comment is in the instruction', async () => {
  const { pi } = await revise({
    feedback: feedbackWindow({
      comments: [
        conversationComment({
          author: { __typename: 'User', login: 'helper' },
          authorAssociation: 'COLLABORATOR',
          body: 'From a collaborator.',
        }),
        conversationComment({
          author: { __typename: 'User', login: 'stranger' },
          authorAssociation: 'NONE',
          body: 'From a stranger.',
        }),
      ],
    }),
  });

  const instruction = instructionOf(pi);
  assert.match(instruction, /From a collaborator\./);
  assert.doesNotMatch(instruction, /From a stranger\./);
});

test('given a revision whose window holds no feedback, when it runs, then pi never starts and the revision ends ok', async () => {
  const { code, pi, runs, revisions } = await revise({ feedback: feedbackWindow() });

  assert.equal(code, 0);
  assert.equal(pi, null);
  assert.deepEqual(runs, []);
  assert.deepEqual(revisions.map(({ state }) => state), ['ok']);
});

test('given a pull request with feedback and a bot user lookup that answers 401 Bad credentials, when forge-revise runs, then the runs list shows a failed revision for the pull request carrying the error', async () => {
  const { code, thrown, pi, revisions, runs, runsList } = await revise({ botLookupFails: true });

  assert.equal(code, 1);
  assert.equal(thrown, 'GitHub answered 401: Bad credentials');
  assert.equal(pi, null);
  assert.deepEqual(revisions.map(({ repository, number, state }) => ({ repository, number, state })), [
    { repository: 'forge', number: 143, state: 'error' },
  ]);
  assert.equal(runs[0]?.status, 'error');
  assert.equal(runs[0]?.error, 'GitHub answered 401: Bad credentials');
  const row = /<tr[^>]*data-run="[^"]*"[^>]*>[\s\S]*?<\/tr>/.exec(runsList)?.[0] ?? '';
  assert.match(textOf(row), /forge PR #143/);
  assert.match(textOf(row), /error/);
  assert.match(textOf(row), /GitHub answered 401: Bad credentials/);
});

test('given a live revision of the pull request and a bot user lookup that answers 401, when forge-revise runs, then the live revision stays the latest and no failed revision is recorded over it', async () => {
  const { code, revisions, runs } = await revise({
    botLookupFails: true,
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
  assert.deepEqual(revisions.map(({ state }) => state), ['running']);
  assert.deepEqual(runs, []);
});

const inlineReview = (comments: { url: string; createdAt: string }[]) => ({
  url: `${PULL_REQUEST_URL}#pullrequestreview-7`,
  author: OWNER,
  authorAssociation: 'OWNER',
  body: 'Overall this needs a second look.',
  submittedAt: '2026-09-22T09:00:00Z',
  comments: {
    nodes: comments.map(({ url, createdAt }) => ({
      url,
      author: OWNER,
      authorAssociation: 'OWNER',
      body: 'This loop is off by one.',
      createdAt,
      path: 'src/loop.ts',
      line: 42,
    })),
  },
});

const INLINE_URL = `${PULL_REQUEST_URL}#discussion_r9`;
const REVIEW_URL = `${PULL_REQUEST_URL}#pullrequestreview-7`;
const COMMENT_URL = `${PULL_REQUEST_URL}#issuecomment-1`;

test('given a revision handed an inline comment, a review summary and a conversation comment, when after the run the thread has a reply, a conversation comment contains the summary\'s URL and forge\'s App has reacted 👍 to the conversation comment, then the revision ends ok', async () => {
  const { code, revisions } = await revise({
    feedback: feedbackWindow({
      reviews: [inlineReview([{ url: INLINE_URL, createdAt: '2026-09-22T09:00:00Z' }])],
      comments: [conversationComment()],
    }),
    answers: feedbackAnswers({
      threads: [
        {
          comments: {
            nodes: [
              { url: INLINE_URL, author: OWNER, createdAt: '2026-09-22T09:00:00Z', ...noReactions },
              repliedBy(FORGE_APP),
            ],
          },
        },
      ],
      comments: [
        { ...conversationComment(), ...thumbsUp() },
        {
          url: `${PULL_REQUEST_URL}#issuecomment-2`,
          body: `Addressed ${REVIEW_URL}`,
          author: FORGE_APP,
          createdAt: '2026-09-22T11:00:00Z',
          ...noReactions,
        },
      ],
    }),
  });

  assert.equal(code, 0);
  assert.deepEqual(revisions.map(({ state, reason }) => ({ state, reason })), [
    { state: 'ok', reason: null },
  ]);
});

test('given a revision handed two items, when after the run only one has been answered, then the revision fails as unanswered, its detail names the other item\'s URL', async () => {
  const { code, revisions } = await revise({
    feedback: feedbackWindow({
      comments: [
        conversationComment(),
        conversationComment({ url: `${PULL_REQUEST_URL}#issuecomment-2`, body: 'And the name.' }),
      ],
    }),
    answers: feedbackAnswers({
      comments: [
        { ...conversationComment(), ...thumbsUp() },
        { ...conversationComment({ url: `${PULL_REQUEST_URL}#issuecomment-2` }), ...noReactions },
      ],
    }),
  });

  assert.equal(code, 1);
  assert.deepEqual(revisions.map(({ state, reason, detail }) => ({ state, reason, detail })), [
    { state: 'error', reason: 'unanswered', detail: `${PULL_REQUEST_URL}#issuecomment-2` },
  ]);
});

test('given a revision handed a conversation comment, when the only response is a 👍 from someone other than forge\'s App, then the revision fails as unanswered', async () => {
  const { code, revisions } = await revise({
    answers: feedbackAnswers({
      comments: [
        {
          ...conversationComment(),
          ...thumbsUp({ __typename: 'User', login: 'helper' }),
        },
      ],
    }),
  });

  assert.equal(code, 1);
  assert.deepEqual(revisions.map(({ state, reason, detail }) => ({ state, reason, detail })), [
    { state: 'error', reason: 'unanswered', detail: COMMENT_URL },
  ]);
});

test('given a revision handed a conversation comment, when forge\'s App reacted with something other than a 👍, then the revision fails as unanswered', async () => {
  const { code, revisions } = await revise({
    answers: feedbackAnswers({
      comments: [{ ...conversationComment(), ...reactedWith('HEART') }],
    }),
  });

  assert.equal(code, 1);
  assert.deepEqual(revisions.map(({ state, reason, detail }) => ({ state, reason, detail })), [
    { state: 'error', reason: 'unanswered', detail: COMMENT_URL },
  ]);
});

test('given a 👍 from forge\'s App made before the previous revision started, when the next revision runs, then it is not an answer', async () => {
  const { code, revisions } = await revise({
    seed: previousRevisionAt('2026-09-21T10:00:00.000Z'),
    feedback: feedbackWindow({
      comments: [conversationComment({ createdAt: '2026-09-21T10:01:00Z' })],
    }),
    answers: feedbackAnswers({
      comments: [
        { ...conversationComment(), ...thumbsUp(FORGE_APP, '2026-09-21T09:00:00Z') },
      ],
    }),
  });

  assert.equal(code, 1);
  assert.deepEqual(revisions.map(({ reason }) => reason).slice(-1), ['unanswered']);
});

test('given forge\'s App commented with a URL that only starts with an unanswered item\'s URL, when the revision ends, then the item is still unanswered', async () => {
  const { code, revisions } = await revise({
    answers: feedbackAnswers({
      comments: [
        { ...conversationComment(), ...noReactions },
        {
          url: `${PULL_REQUEST_URL}#issuecomment-2`,
          body: `Addressed ${COMMENT_URL}0`,
          author: FORGE_APP,
          createdAt: '2026-09-22T11:00:00Z',
          ...noReactions,
        },
      ],
    }),
  });

  assert.equal(code, 1);
  assert.deepEqual(revisions.map(({ reason, detail }) => ({ reason, detail })), [
    { reason: 'unanswered', detail: COMMENT_URL },
  ]);
});
