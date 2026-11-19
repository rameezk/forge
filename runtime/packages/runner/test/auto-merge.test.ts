import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type RiskGrade, type RiskLevel } from '@forge/shared';
import { main as autoMerge } from '../src/auto-merge-main.ts';
import { APP_ID, BOT_LOGIN, fakeGithubApp, routedThrough } from '../../shared/test/fixtures/fake-github-app.ts';
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
  hold?: 'maintainer' | 'outsider';
  repository?: string;
}

const HEAD = (number: number): string => `head-${number}`;

const forge = (pulls: Pull[], autoMergeOn: string[] = ['forge']) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'forge-auto-merge-'));
  const configPath = join(stateDir, 'runtime.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      harnesses: {},
      workers: {},
      repositories: {
        forge: { github: 'rameezk/forge', grading: true, ...(autoMergeOn.includes('forge') ? { autoMerge: true } : {}) },
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
  const held = new Map(pulls.flatMap((pull) => (pull.hold === undefined ? [] : [[pull.number, pull.hold] as const])));
  const removedLabels: { number: number; label: string }[] = [];
  const hooks = { beforeMerge: (_number: number): void => {}, refuseMerges: false, foreignApprovals: new Set<number>() };
  const github: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const json = (data: unknown, status = 200): Response =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    const authorization = new Headers(init?.headers).get('authorization') ?? '';
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
    const labelsOf = /^\/repos\/rameezk\/(forge|other)\/issues\/(\d+)\/labels(?:\/(.+))?$/.exec(url.pathname);
    if (labelsOf !== null) {
      const number = Number(labelsOf[2]);
      if (init?.method === 'DELETE') {
        removedLabels.push({ number, label: decodeURIComponent(labelsOf[3] ?? '') });
        held.delete(number);
        return json([]);
      }
      return json(held.has(number) ? [{ name: 'forge:hold' }] : []);
    }
    const permissionOf = /^\/repos\/rameezk\/(forge|other)\/collaborators\/([^/]+)\/permission$/.exec(url.pathname);
    if (permissionOf !== null) {
      return json({ permission: permissionOf[2] === 'maintainer' ? 'write' : 'read' });
    }
    const commentOn = /^\/repos\/rameezk\/(forge|other)\/issues\/(\d+)\/comments$/.exec(url.pathname);
    if (commentOn !== null && init?.method === 'POST') {
      comments.push({ number: Number(commentOn[2]), authorization, body: (JSON.parse(String(init.body)) as { body: string }).body });
      return json({ id: 2 }, 201);
    }
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: { number: number } };
    const pull = pulls.find((candidate) => candidate.number === variables.number);
    const operation = /query (\w+)/.exec(query)?.[1];
    if (operation === 'PullRequestLabelEvents') {
      const applier = pull === undefined ? undefined : held.get(pull.number);
      return json({
        data: {
          repository: {
            pullRequest: {
              timelineItems: {
                pageInfo: { hasPreviousPage: false, startCursor: null },
                nodes:
                  applier === undefined
                    ? []
                    : [
                        {
                          __typename: 'LabeledEvent',
                          createdAt: '2026-11-18T11:45:00.000Z',
                          label: { name: 'forge:hold' },
                          actor: { __typename: 'User', login: applier === 'maintainer' ? 'maintainer' : 'stranger' },
                        },
                      ],
              },
            },
          },
        },
      });
    }
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
      const { result } = await journaled(() => autoMerge(env, fetch, () => NOW));
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
    release: (number: number): void => {
      held.delete(number);
    },
    changeHead: (number: number): void => {
      heads.set(number, `moved-${number}`);
    },
    reviews,
    merges,
    comments,
    removedLabels,
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
  for (const gate of ['checks', 'feedback', 'hold']) assert.match(comment?.body ?? '', new RegExp(gate, 'i'));
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

test('given an eligible pull request with forge:hold applied by a maintainer, when the pass runs, then it is not approved or merged and its label stays', async () => {
  const f = forge([{ number: 7, hold: 'maintainer' }]);
  assert.equal(await f.run(), 0);
  assert.deepEqual([f.reviews, f.merges, f.comments, f.removedLabels], [[], [], [], []]);
  assert.equal(outcomeOf(f, 7), 'open');
});

test('given a held pull request, when the maintainer removes forge:hold and the pass runs, then it auto-merges', async () => {
  const f = forge([{ number: 7, hold: 'maintainer' }]);
  await f.run();
  f.release(7);
  assert.equal(await f.run(), 0);
  assert.equal(f.merges.length, 1);
  assert.equal(outcomeOf(f, 7), 'auto-merged');
});

test('given an eligible pull request with forge:hold applied by someone who is not a maintainer, when the pass runs, then the label is removed and the pull request auto-merges', async () => {
  const f = forge([{ number: 7, hold: 'outsider' }]);
  assert.equal(await f.run(), 0);
  assert.deepEqual(f.removedLabels, [{ number: 7, label: 'forge:hold' }]);
  assert.equal(f.merges.length, 1);
  assert.equal(outcomeOf(f, 7), 'auto-merged');
});
