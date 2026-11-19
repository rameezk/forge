import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type RiskGrade, type RiskLevel } from '@forge/shared';
import { main as autoMerge } from '../src/auto-merge-main.ts';
import { APP_ID, BOT_LOGIN, fakeGithubApp, routedThrough } from '../../shared/test/fixtures/fake-github-app.ts';
import { drawsSample, SAMPLE_RATE } from '../src/auto-merge.ts';
import { journaled } from './helpers.ts';

const NOW = '2026-11-18T12:00:00.000Z';

interface Pull {
  number: number;
  level?: RiskLevel;
  uncertain?: boolean;
  draft?: boolean;
  checks?: 'passing' | 'failing' | 'pending';
  unresolvedThread?: boolean;
  feedback?: boolean;
  revising?: boolean;
  repository?: string;
  files?: ChangedFileSpec[];
}

interface ChangedFileSpec {
  filename: string;
  additions: number;
  deletions: number;
  patch?: string;
  previous_filename?: string;
  status?: string;
}

const edit = (filename: string, additions = 3, deletions = 1): ChangedFileSpec => ({
  filename,
  additions,
  deletions,
  patch: '@@ -1 +1 @@\n-old\n+new',
});

const UNSAMPLED = 0.9;
const SAMPLED = 0.1;

const HEAD = (number: number): string => `head-${number}`;

const forge = (
  pulls: Pull[],
  autoMergeOn: string[] = ['forge'],
  forgeSettings: { protectedPaths?: string[]; autoMergeSizeCap?: number } = {},
) => {
  const dice = { next: UNSAMPLED };
  const stateDir = mkdtempSync(join(tmpdir(), 'forge-auto-merge-'));
  const configPath = join(stateDir, 'runtime.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      harnesses: {},
      workers: {},
      repositories: {
        forge: { github: 'rameezk/forge', grading: true, ...forgeSettings, ...(autoMergeOn.includes('forge') ? { autoMerge: true } : {}) },
        other: { github: 'rameezk/other', grading: true, ...(autoMergeOn.includes('other') ? { autoMerge: true } : {}) },
      },
      grading: { model: 'typesafe/jev-1.13' },
    }),
  );
  const app = fakeGithubApp(['rameezk/forge', 'rameezk/other']);
  const keyPath = join(stateDir, 'github-app-private-key');
  writeFileSync(keyPath, app.privateKey);
  const env = {
    FORGE_RUNTIME_CONFIG: configPath,
    FORGE_STATE_DIR: stateDir,
    FORGE_GITHUB_APP_ID: APP_ID,
    FORGE_GITHUB_APP_PRIVATE_KEY_FILE: keyPath,
  };

  const store = Store.open(join(stateDir, 'forge.db'));
  for (const pull of pulls) {
    const repository = pull.repository ?? 'forge';
    const grade: RiskGrade = {
      repository,
      number: pull.number,
      headSha: HEAD(pull.number),
      fingerprint: 'typesafe/jev-1.13:abc',
      model: 'typesafe/jev-1.13',
      probabilities: { trivial: 0.1, low: 0.7, moderate: 0.15, high: 0.05 },
      score: 0.4,
      confidence: 0.9,
      level: pull.level ?? 'low',
      uncertain: pull.uncertain ?? false,
      costUsd: 0,
      gradedAt: '2026-11-18T11:00:00.000Z',
    };
    store.recordRiskGrade(grade);
    if (pull.revising === true) {
      store.startRevision(
        { repository, number: pull.number, url: `https://github.com/rameezk/${repository}/pull/${pull.number}` },
        [10],
        `run-${pull.number}`,
        NOW,
        5,
      );
    }
  }
  for (const repository of new Set(pulls.map((pull) => pull.repository ?? 'forge'))) {
    store.recordWatchedPullRequests(
      repository,
      pulls
        .filter((pull) => (pull.repository ?? 'forge') === repository)
        .map((pull) => ({
          number: pull.number,
          url: `https://github.com/rameezk/${repository}/pull/${pull.number}`,
          closes: [10],
          newestFeedbackAt: pull.feedback === true ? '2026-11-18T11:30:00.000Z' : null,
          mergeable: 'MERGEABLE' as const,
          headSha: HEAD(pull.number),
          draft: pull.draft ?? false,
          defaultSha: 'default-a',
        })),
    );
  }
  store.close();

  const heads = new Map(pulls.map((pull) => [pull.number, HEAD(pull.number)]));
  const reviews: { number: number; authorization: string; body: Record<string, unknown> }[] = [];
  const merges: { number: number; body: Record<string, unknown> }[] = [];
  const comments: { number: number; authorization: string; body: string }[] = [];
  const labels: { number: number; labels: string[] }[] = [];
  const hooks = { beforeMerge: (_number: number): void => {}, refuseMerges: false, failLabels: false, foreignApprovals: new Set<number>() };
  const github: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const json = (data: unknown, status = 200): Response =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    const authorization = new Headers(init?.headers).get('authorization') ?? '';
    const filesOf = /^\/repos\/rameezk\/(forge|other)\/pulls\/(\d+)\/files$/.exec(url.pathname);
    if (filesOf !== null) {
      const pull = pulls.find((candidate) => candidate.number === Number(filesOf[2]));
      const page = Number(url.searchParams.get('page') ?? '1');
      const all = pull?.files ?? [edit('src/a.ts')];
      return json(all.slice((page - 1) * 100, page * 100));
    }
    const pullOf = /^\/repos\/rameezk\/(forge|other)\/pulls\/(\d+)(\/reviews|\/merge)?$/.exec(url.pathname);
    if (pullOf !== null) {
      const number = Number(pullOf[2]);
      const pull = pulls.find((candidate) => candidate.number === number);
      if (pull === undefined) return json({}, 404);
      if (pullOf[3] === '/reviews' && init?.method !== 'POST') {
        return json([
          ...(hooks.foreignApprovals.has(number)
            ? [{ state: 'APPROVED', commit_id: heads.get(number), user: { login: 'dependabot[bot]', type: 'Bot' } }]
            : []),
          ...reviews
            .filter((review) => review.number === number)
            .map((review) => ({ state: 'APPROVED', commit_id: review.body.commit_id, user: { login: BOT_LOGIN, type: 'Bot' } })),
        ]);
      }
      if (pullOf[3] === '/reviews') {
        reviews.push({ number, authorization, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return json({ id: 1 });
      }
      if (pullOf[3] === '/merge') {
        hooks.beforeMerge(number);
        if (hooks.refuseMerges) return json({ message: 'Required status check is expected' }, 405);
        const body = JSON.parse(String(init?.body)) as { sha?: string };
        if (body.sha !== heads.get(number)) return json({ message: 'Head branch was modified' }, 409);
        merges.push({ number, body });
        return json({ merged: true });
      }
      return json({ number, state: 'open', draft: pull.draft ?? false, head: { sha: heads.get(number) } });
    }
    const labelOn = /^\/repos\/rameezk\/(forge|other)\/issues\/(\d+)\/labels$/.exec(url.pathname);
    if (labelOn !== null && init?.method === 'POST') {
      if (hooks.failLabels) return json({ message: 'nope' }, 500);
      labels.push({ number: Number(labelOn[2]), labels: (JSON.parse(String(init.body)) as { labels: string[] }).labels });
      return json([], 200);
    }
    const commentOn = /^\/repos\/rameezk\/(forge|other)\/issues\/(\d+)\/comments$/.exec(url.pathname);
    if (commentOn !== null && init?.method === 'POST') {
      comments.push({ number: Number(commentOn[2]), authorization, body: (JSON.parse(String(init.body)) as { body: string }).body });
      return json({ id: 2 }, 201);
    }
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: { number: number } };
    const pull = pulls.find((candidate) => candidate.number === variables.number);
    const operation = /query (\w+)/.exec(query)?.[1];
    if (operation === 'PullRequestReadiness') {
      const status = pull?.checks ?? 'passing';
      return json({
        data: {
          repository: {
            pullRequest: {
              isDraft: pull?.draft ?? false,
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        contexts: {
                          pageInfo: { hasNextPage: false },
                          nodes: [
                            {
                              __typename: 'CheckRun',
                              name: 'ci',
                              status: status === 'pending' ? 'IN_PROGRESS' : 'COMPLETED',
                              conclusion: status === 'failing' ? 'FAILURE' : 'SUCCESS',
                              isRequired: true,
                            },
                          ],
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      });
    }
    if (operation === 'ReviewThreads') {
      return json({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false },
                nodes: [{ isResolved: pull?.unresolvedThread !== true }],
              },
            },
          },
        },
      });
    }
    throw new Error(`unexpected GitHub request ${String(operation)}`);
  };
  const fetch = routedThrough(app, github);

  return {
    run: async (): Promise<number> => {
      const { result } = await journaled(() => autoMerge(env, fetch, () => NOW, () => dice.next));
      return result;
    },
    withStore: <T>(use: (store: Store) => T): T => {
      const opened = Store.open(join(stateDir, 'forge.db'));
      try {
        return use(opened);
      } finally {
        opened.close();
      }
    },
    changeHead: (number: number): void => {
      heads.set(number, `moved-${number}`);
    },
    reviews,
    merges,
    comments,
    labels,
    dice,
    hooks,
    mints: app.mints,
  };
};

const outcomeOf = (f: ReturnType<typeof forge>, number: number, repository = 'forge'): string | undefined =>
  f.withStore((store) => store.riskGrade(repository, number, HEAD(number))?.outcome);

test('given an opted-in repository and a settled pull request graded low and certain with green checks and no feedback, when the pass runs, then the Reviewer App approves it, merges it at the graded head, comments with the grade, the head and the gates, and the grade settles as auto-merged', async () => {
  const f = forge([{ number: 7 }]);
  assert.equal(await f.run(), 0);

  assert.equal(f.reviews.length, 1);
  assert.equal(f.reviews[0]?.body.event, 'APPROVE');
  assert.equal(f.reviews[0]?.body.commit_id, HEAD(7));
  assert.match(f.reviews[0]?.authorization ?? '', /^bearer ghs_review_/i);
  assert.deepEqual(f.merges, [{ number: 7, body: { sha: HEAD(7), merge_method: 'squash' } }]);
  assert.equal(f.comments.length, 1);
  const [comment] = f.comments;
  assert.match(comment?.body ?? '', /low/);
  assert.match(comment?.body ?? '', /0\.90/);
  assert.ok(comment?.body.includes(HEAD(7)));
  for (const gate of ['checks', 'feedback']) assert.match(comment?.body ?? '', new RegExp(gate, 'i'));
  assert.equal(outcomeOf(f, 7), 'auto-merged');
});

test('given a trivial pull request, when the pass runs, then it auto-merges too', async () => {
  const f = forge([{ number: 8, level: 'trivial' }]);
  await f.run();
  assert.equal(f.merges.length, 1);
});

test('given a low but uncertain pull request and a moderate one, when the pass runs, then neither is approved or merged', async () => {
  const f = forge([
    { number: 1, uncertain: true },
    { number: 2, level: 'moderate' },
    { number: 3, level: 'high' },
  ]);
  assert.equal(await f.run(), 0);
  assert.deepEqual([f.reviews, f.merges, f.comments], [[], [], []]);
  assert.equal(outcomeOf(f, 1), 'open');
});

test('given low certain pull requests that are a draft, running a revision, failing or pending a required check, with an unresolved review thread or with open feedback, when the pass runs, then none is approved or merged', async () => {
  const f = forge([
    { number: 1, draft: true },
    { number: 2, revising: true },
    { number: 3, checks: 'failing' },
    { number: 4, checks: 'pending' },
    { number: 5, unresolvedThread: true },
    { number: 6, feedback: true },
  ]);
  assert.equal(await f.run(), 0);
  assert.deepEqual([f.reviews, f.merges, f.comments], [[], [], []]);
});

test('given a repository that has not opted in and an otherwise eligible pull request, when the pass runs, then it is not approved or merged and no token is minted', async () => {
  const f = forge([{ number: 1, repository: 'other' }], ['forge']);
  assert.equal(await f.run(), 0);
  assert.deepEqual([f.reviews, f.merges, f.comments, f.mints], [[], [], [], []]);
  assert.equal(outcomeOf(f, 1, 'other'), 'open');
});

test('given a pull request whose head changes after the pass checked it, when the merge is attempted, then nothing merges, the grade stays open and the pass reports the failure', async () => {
  const f = forge([{ number: 7 }]);
  f.hooks.beforeMerge = (number) => f.changeHead(number);
  assert.equal(await f.run(), 1);
  assert.deepEqual(f.merges, []);
  assert.deepEqual(f.comments, []);
  assert.equal(outcomeOf(f, 7), 'open');
  assert.equal(f.withStore((store) => store.autoMergeCandidates(['forge'], NOW).length), 1);
});

test('given an auto-merged grade and a grade merged by a person, when the store settles a merge, then they stay distinct outcomes', async () => {
  const f = forge([{ number: 1 }, { number: 2 }]);
  f.withStore((store) => store.settleRiskGrade({ repository: 'forge', number: 2, headSha: HEAD(2) }, 'merged', NOW));
  await f.run();
  assert.equal(outcomeOf(f, 1), 'auto-merged');
  assert.equal(outcomeOf(f, 2), 'merged');
  assert.equal(f.merges.length, 1);
});

test('given the pass started a merge, when frontier sync then sees the pull request merged, then the grade settles as auto-merged and not merged', async () => {
  const f = forge([{ number: 1 }]);
  f.withStore((store) => {
    store.markAutoMergeStarted({ repository: 'forge', number: 1, headSha: HEAD(1) }, NOW);
    store.settleRiskGrade({ repository: 'forge', number: 1, headSha: HEAD(1) }, 'merged', NOW);
  });
  assert.equal(outcomeOf(f, 1), 'auto-merged');
});

test('given a merge that keeps being refused at an unchanged head, when the pass runs again, then the Reviewer App approves that head only once', async () => {
  const f = forge([{ number: 7 }]);
  f.hooks.refuseMerges = true;
  assert.equal(await f.run(), 1);
  assert.equal(await f.run(), 1);
  assert.equal(f.reviews.length, 1);
  assert.deepEqual(f.merges, []);
  f.hooks.refuseMerges = false;
  assert.equal(await f.run(), 0);
  assert.equal(f.reviews.length, 1);
  assert.equal(f.merges.length, 1);
  assert.equal(outcomeOf(f, 7), 'auto-merged');
});

test('given another bot already approved the head, when the pass runs, then the Reviewer App still approves it itself', async () => {
  const f = forge([{ number: 7 }]);
  f.hooks.foreignApprovals.add(7);
  assert.equal(await f.run(), 0);
  assert.equal(f.reviews.length, 1);
  assert.equal(f.merges.length, 1);
});

const merged = (f: ReturnType<typeof forge>): number[] => f.merges.map(({ number }) => number);

test('given low pull requests that change a CI workflow, a nix file, agent instructions, a skill, a sops file or a dependency manifest, when the pass runs, then none is approved or merged', async () => {
  const paths = [
    '.github/workflows/ci.yml',
    'flake.nix',
    'infra/nixos/runtime.nix',
    'AGENTS.md',
    'docs/CLAUDE.md',
    '.claude/settings.json',
    'plugin/skills/work-on/SKILL.md',
    'secrets/runtime.yaml',
    'runtime/package.json',
    'Cargo.toml',
  ];
  const f = forge(paths.map((path, index) => ({ number: index + 1, files: [edit('src/a.ts'), edit(path)] })));
  assert.equal(await f.run(), 0);
  assert.deepEqual([f.reviews, f.merges, f.comments], [[], [], []]);
});

test('given a pull request that renames a file away from a protected path, when the pass runs, then it is not merged', async () => {
  const f = forge([{ number: 1, files: [{ ...edit('src/ci.yml', 0, 0), previous_filename: '.github/workflows/ci.yml' }] }]);
  await f.run();
  assert.deepEqual(f.merges, []);
});

test('given a repository that adds a protected path and a low pull request that changes only that path, when the pass runs, then it is not merged, while a pull request outside it is', async () => {
  const f = forge(
    [
      { number: 1, files: [edit('billing/ledger.ts')] },
      { number: 2, files: [edit('src/a.ts')] },
    ],
    ['forge'],
    { protectedPaths: ['billing/**'] },
  );
  await f.run();
  assert.deepEqual(merged(f), [2]);
});

test('given a runtime config in which a repository tries to drop a default protected path, when the pass runs, then the default still applies', async () => {
  const f = forge([{ number: 1, files: [edit('.github/workflows/ci.yml')] }], ['forge'], { protectedPaths: [] });
  await f.run();
  assert.deepEqual(f.merges, []);
});

test('given low pull requests of 301 changed lines, one under the default cap and one in a repository whose cap is raised, when the pass runs, then only the raised one merges', async () => {
  const big = [edit('src/a.ts', 200, 101)];
  const under = forge([{ number: 1, files: big }]);
  await under.run();
  assert.deepEqual(under.merges, []);
  const raised = forge([{ number: 1, files: big }], ['forge'], { autoMergeSizeCap: 301 });
  await raised.run();
  assert.deepEqual(merged(raised), [1]);
});

test('given a low pull request of exactly 300 changed lines, when the pass runs, then it merges', async () => {
  const f = forge([{ number: 1, files: [edit('src/a.ts', 150, 100), edit('src/b.ts', 25, 25)] }]);
  await f.run();
  assert.deepEqual(merged(f), [1]);
});

test('given low pull requests that change a lockfile, a generated file or a file GitHub gave no patch for, when the pass runs, then only a pure rename merges', async () => {
  const f = forge([
    { number: 1, files: [edit('src/a.ts'), { filename: 'poetry.lock', additions: 2, deletions: 2 }] },
    { number: 2, files: [edit('src/gen.generated.ts')] },
    { number: 3, files: [edit('web/dist/app.min.js')] },
    { number: 4, files: [{ filename: 'src/huge.ts', additions: 9, deletions: 0 }] },
    { number: 5, files: [{ filename: 'assets/logo.png', additions: 0, deletions: 0, status: 'modified' }] },
    { number: 6, files: [{ filename: 'src/moved.ts', additions: 0, deletions: 0, status: 'renamed', previous_filename: 'src/old.ts' }] },
  ]);
  await f.run();
  assert.deepEqual(merged(f), [6]);
});

test('given a pull request that passes every gate, when it auto-merges, then the comment names the protected path check, the size against the cap and that Jev saw every changed file', async () => {
  const f = forge([{ number: 1, files: [edit('src/a.ts', 10, 5)] }]);
  await f.run();
  const body = f.comments[0]?.body ?? '';
  assert.match(body, /protected path/i);
  assert.match(body, /15 changed lines, within the cap of 300/);
  assert.match(body, /Jev saw every changed file/);
});

test('given low pull requests that change a dot-named file under a protected directory or a differently cased protected path, when the pass runs, then none is merged', async () => {
  const paths = [
    '.github/workflows/.evil.yml',
    '.claude/.x',
    'plugin/skills/.x/a.md',
    'infra/.x',
    'pkg/.hidden.nix',
    'web/.b/package.json',
    '.GitHub/workflows/ci.yml',
    'Infra/main.tf',
    'agents.md',
    'sub/.github/workflows/x.yml',
    '.husky/pre-commit',
    'x\ny/package.json',
    'infra/a\nb',
    'docs/CODEOWNERS',
    'Dockerfile.prod',
  ];
  const f = forge(paths.map((path, index) => ({ number: index + 1, files: [edit(path)] })));
  assert.equal(await f.run(), 0);
  assert.deepEqual(f.merges, []);
});

test('given a repository that adds a dot-named protected path, when the pass runs, then it is not merged', async () => {
  const f = forge([{ number: 1, files: [edit('billing/.ledger')] }], ['forge'], { protectedPaths: ['billing/*'] });
  await f.run();
  assert.deepEqual(f.merges, []);
});

test('given a pull request whose changed file list reaches the 3000 files GitHub returns, when the pass runs, then it is not merged because the list may be cut short', async () => {
  const files = Array.from({ length: 3000 }, (_, index) => ({
    filename: `src/f${index}.ts`,
    additions: 0,
    deletions: 0,
    status: 'renamed',
    previous_filename: `src/g${index}.ts`,
  }));
  const f = forge([{ number: 1, files }]);
  await f.run();
  assert.deepEqual(f.merges, []);
});

const labelled = (f: ReturnType<typeof forge>, number: number): string[] =>
  f.labels.filter((entry) => entry.number === number).flatMap((entry) => entry.labels);

test('given an eligible pull request whose draw sampled it, when the pass runs, then it is labelled forge:sampled, gets a comment saying it would have auto-merged and why, and is not approved or merged', async () => {
  const f = forge([{ number: 7 }]);
  f.dice.next = SAMPLED;
  assert.equal(await f.run(), 0);
  assert.deepEqual(labelled(f, 7), ['forge:sampled']);
  assert.deepEqual([f.reviews, f.merges], [[], []]);
  assert.equal(f.comments.length, 1);
  const body = f.comments[0]?.body ?? '';
  assert.match(body, /would have auto-merged/);
  assert.match(body, /sampled/);
  assert.match(body, /low, confidence 0\.90/);
  assert.match(body, /Checks: every required check is green/);
  assert.equal(outcomeOf(f, 7), 'open');
});

test('given a sampled pull request that receives a new head passing every gate, when the pass runs again, then it is still sampled, still not merged and not announced twice', async () => {
  const f = forge([{ number: 7 }]);
  f.dice.next = SAMPLED;
  await f.run();
  f.dice.next = UNSAMPLED;
  f.changeHead(7);
  f.withStore((store) => {
    store.recordRiskGrade({ ...store.riskGrade('forge', 7, HEAD(7))!, headSha: 'moved-7' });
    store.recordWatchedPullRequests('forge', [{ number: 7, url: 'https://github.com/rameezk/forge/pull/7', closes: [10], newestFeedbackAt: null, mergeable: 'MERGEABLE', headSha: 'moved-7', draft: false, defaultSha: 'default-a' }]);
  });
  assert.equal(await f.run(), 0);
  assert.deepEqual([f.reviews, f.merges], [[], []]);
  assert.equal(f.comments.length, 1);
  assert.deepEqual(labelled(f, 7), ['forge:sampled']);
  assert.equal(f.withStore((store) => store.pullRequestSampled('forge', 7)), true);
});

test('given an eligible pull request whose draw did not sample it, when the pass runs, then it auto-merges and a later pass does not redraw it', async () => {
  const f = forge([{ number: 7 }]);
  await f.run();
  assert.deepEqual(merged(f), [7]);
  assert.deepEqual(f.labels, []);
  assert.equal(f.withStore((store) => store.pullRequestSampled('forge', 7)), false);
  f.dice.next = SAMPLED;
  await f.run();
  assert.equal(f.withStore((store) => store.pullRequestSampled('forge', 7)), false);
});

test('given a sampled pull request whose label could not be applied, when the pass runs again, then the draw stands and the sample is announced once the label lands', async () => {
  const f = forge([{ number: 7 }]);
  f.dice.next = SAMPLED;
  f.hooks.failLabels = true;
  assert.equal(await f.run(), 1);
  assert.equal(f.comments.length, 0);
  f.hooks.failLabels = false;
  f.dice.next = UNSAMPLED;
  assert.equal(await f.run(), 0);
  assert.deepEqual(labelled(f, 7), ['forge:sampled']);
  assert.equal(f.comments.length, 1);
  assert.deepEqual(f.merges, []);
});

test('given a pull request that fails a gate, when the pass runs, then no draw is made for it', async () => {
  const f = forge([{ number: 1, checks: 'failing' }]);
  f.dice.next = SAMPLED;
  await f.run();
  assert.equal(f.withStore((store) => store.pullRequestSampled('forge', 1)), null);
  assert.deepEqual(f.labels, []);
});

test('given many draws from a seeded random source, when each is drawn, then the share sampled is a quarter for that seed', () => {
  let state = 20261119;
  const random = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const draws = 20000;
  const sampled = Array.from({ length: draws }, () => drawsSample(random)).filter(Boolean).length;
  assert.ok(Math.abs(sampled / draws - SAMPLE_RATE) < 0.01, `sampled ${sampled / draws}`);
  assert.equal(SAMPLE_RATE, 0.25);
});
