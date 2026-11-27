import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoMergeCandidates, pullRequestSampled, SAMPLE_RATE, Store, type RiskGrade, type RiskLevel } from '@forge/shared';
import { main as autoMerge } from '../src/auto-merge-main.ts';
import { APP_ID, BOT_LOGIN, fakeGithubApp, routedThrough } from '../../shared/test/fixtures/fake-github-app.ts';
import { drawsSample } from '../src/auto-merge.ts';
import { journaled } from './helpers.ts';
import { riskGradeOf } from '../../shared/test/fixtures/risk-grades.ts';
import { bypassable, PROTECTED, unreadable, withProtectedRepositories, type RepositoryRules } from '../../shared/test/fixtures/branch-rules.ts';

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
  otherLabels?: number;
  repository?: string;
  files?: ChangedFileSpec[];
  fingerprint?: string;
  closes?: ClosingIssue[];
}

interface ClosingIssue {
  number: number;
  repository?: 'forge' | 'other';
  state?: 'open' | 'closed';
}

interface ChangedFileSpec {
  filename: string;
  additions: number;
  deletions: number;
  patch?: string;
  previous_filename?: string;
  status?: string;
}

interface CheckRunWrite {
  method: string;
  id: number;
  authorization: string;
  body: { name?: string; head_sha?: string; status: string; conclusion: string; output: { title: string; summary: string } };
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

type Settled = 'held' | 'failed' | 'auto';

const COHORT = 'typesafe/jev-1.13:abc';

let tick = 0;

const settleHistory = (store: Store, history: Settled[], fingerprint = COHORT): void => {
  for (const outcome of history) {
    tick += 1;
    const grade: RiskGrade = {
      repository: 'forge',
      number: 1000 + tick,
      headSha: `old-${tick}`,
      fingerprint,
      model: 'typesafe/jev-1.13',
      probabilities: { trivial: 0.1, low: 0.7, moderate: 0.15, high: 0.05 },
      score: 0.4,
      confidence: 0.9,
      level: 'low',
      uncertain: false,
      costUsd: 0,
      gradedAt: '2026-11-17T09:00:00.000Z',
    };
    const at = new Date(Date.parse('2026-11-17T10:00:00.000Z') + tick * 1000).toISOString();
    store.grades.recordRiskGrade(grade);
    if (outcome === 'auto') store.autoMerge.markAutoMergeStarted(grade, at);
    store.grades.settleRiskGrade(grade, outcome === 'failed' ? 'closed' : 'merged', at);
  }
};

const held = (count: number): Settled[] => Array<Settled>(count).fill('held');
const failed = (count: number): Settled[] => Array<Settled>(count).fill('failed');

const forge = (
  pulls: Pull[],
  autoMergeOn: string[] = ['forge'],
  forgeSettings: { protectedPaths?: string[]; autoMergeSizeCap?: number } = {},
  reviewerApp: {
    installed?: string[];
    rules?: Record<string, RepositoryRules>;
    storedRuleFailures?: string[];
    unreachable?: boolean;
    unaccepted?: Record<string, string>;
  } = {},
  history: Settled[] = held(10),
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
  const app = fakeGithubApp(reviewerApp.installed ?? ['rameezk/forge', 'rameezk/other'], 3600, reviewerApp.unaccepted);
  const keyPath = join(stateDir, 'github-app-private-key');
  writeFileSync(keyPath, app.privateKey);
  const env = {
    FORGE_RUNTIME_CONFIG: configPath,
    FORGE_STATE_DIR: stateDir,
    FORGE_GITHUB_APP_ID: APP_ID,
    FORGE_GITHUB_APP_PRIVATE_KEY_FILE: keyPath,
  };

  const store = Store.open(join(stateDir, 'forge.db'));
  if (reviewerApp.storedRuleFailures !== undefined) {
    store.frontier.recordBranchRules({ repository: 'forge', github: 'rameezk/forge', failures: reviewerApp.storedRuleFailures });
  }
  settleHistory(store, history);
  for (const pull of pulls) {
    const repository = pull.repository ?? 'forge';
    const grade: RiskGrade = {
      repository,
      number: pull.number,
      headSha: HEAD(pull.number),
      fingerprint: pull.fingerprint ?? COHORT,
      model: 'typesafe/jev-1.13',
      probabilities: { trivial: 0.1, low: 0.7, moderate: 0.15, high: 0.05 },
      score: 0.4,
      confidence: 0.9,
      level: pull.level ?? 'low',
      uncertain: pull.uncertain ?? false,
      costUsd: 0,
      gradedAt: '2026-11-18T11:00:00.000Z',
    };
    store.grades.recordRiskGrade(grade);
    if (pull.revising === true) {
      store.workloads.startRevision(
        { repository, number: pull.number, url: `https://github.com/rameezk/${repository}/pull/${pull.number}` },
        [10],
        `run-${pull.number}`,
        NOW,
        5,
      );
    }
  }
  for (const repository of new Set(pulls.map((pull) => pull.repository ?? 'forge'))) {
    store.workloads.recordWatchedPullRequests(
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
  const checkRuns: CheckRunWrite[] = [];
  const labels: { number: number; labels: string[] }[] = [];
  const issues = new Map<string, { state: 'open' | 'closed'; labels: string[] }>();
  for (const pull of pulls) {
    for (const { number, repository = 'forge', state = 'open' } of pull.closes ?? []) {
      issues.set(`${repository}#${number}`, { state, labels: ['ready-for-agent', 'forge:done'] });
    }
  }
  const issueWrites: { repository: string; number: number; body: Record<string, unknown> }[] = [];
  const mergedPulls = new Set<number>();
  const closedPulls = new Set<number>();
  const hooks = { failIssueCloses: new Set<number>(), failComments: false, failCheckRuns: false, beforeMerge: (_number: number): void => {}, refuseMerges: false, failLabels: false, foreignApprovals: new Set<number>() };
  const answering: typeof globalThis.fetch = async (input, init) => {
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
        mergedPulls.add(number);
        return json({ merged: true });
      }
      return json({
        number,
        state: mergedPulls.has(number) || closedPulls.has(number) ? 'closed' : 'open',
        merged: mergedPulls.has(number),
        draft: pull.draft ?? false,
        head: { sha: heads.get(number) },
      });
    }
    const issueOf = /^\/repos\/rameezk\/(forge|other)\/issues\/(\d+)$/.exec(url.pathname);
    if (issueOf !== null) {
      const key = `${issueOf[1]}#${issueOf[2]}`;
      const issue = issues.get(key);
      if (issue === undefined) return json({}, 404);
      if (init?.method === 'PATCH') {
        if (hooks.failIssueCloses.has(Number(issueOf[2]))) return json({ message: 'nope' }, 500);
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        issueWrites.push({ repository: issueOf[1] ?? '', number: Number(issueOf[2]), body });
        if (body.state === 'closed') issue.state = 'closed';
        return json({ number: Number(issueOf[2]), state: issue.state });
      }
      return json({ number: Number(issueOf[2]), state: issue.state, labels: issue.labels.map((name) => ({ name })) });
    }
    const checkRunsOf = /^\/repos\/rameezk\/(forge|other)\/check-runs(?:\/(\d+))?$/.exec(url.pathname);
    if (checkRunsOf !== null) {
      if (hooks.failCheckRuns) return json({ message: 'nope' }, 500);
      const body = JSON.parse(String(init?.body)) as CheckRunWrite['body'];
      const id = checkRunsOf[2] === undefined ? checkRuns.filter(({ method }) => method === 'POST').length + 1 : Number(checkRunsOf[2]);
      checkRuns.push({ method: String(init?.method), id, authorization, body });
      return json({ id }, init?.method === 'POST' ? 201 : 200);
    }
    const labelsOf = /^\/repos\/rameezk\/(forge|other)\/issues\/(\d+)\/labels(?:\/(.+))?$/.exec(url.pathname);
    if (labelsOf !== null) {
      const number = Number(labelsOf[2]);
      if (init?.method === 'POST') {
        if (hooks.failLabels) return json({ message: 'nope' }, 500);
        labels.push({ number, labels: (JSON.parse(String(init.body)) as { labels: string[] }).labels });
        return json([], 200);
      }
      if (init?.method === 'DELETE') {
        removedLabels.push({ number, label: decodeURIComponent(labelsOf[3] ?? '') });
        held.delete(number);
        return json([]);
      }
      const filler = Array.from({ length: pulls.find((pull) => pull.number === number)?.otherLabels ?? 0 }, (_, index) => ({ name: `label-${index}` }));
      const present = [...filler, ...(held.has(number) ? [{ name: 'forge:hold' }] : [])];
      const page = Number(url.searchParams.get('page') ?? '1');
      return json(present.slice((page - 1) * 100, page * 100));
    }
    const permissionOf = /^\/repos\/rameezk\/(forge|other)\/collaborators\/([^/]+)\/permission$/.exec(url.pathname);
    if (permissionOf !== null) {
      return json({ permission: permissionOf[2] === 'maintainer' ? 'write' : 'read' });
    }
    const commentOn = /^\/repos\/rameezk\/(forge|other)\/issues\/(\d+)\/comments$/.exec(url.pathname);
    if (commentOn !== null && init?.method === 'POST') {
      if (hooks.failComments) return json({ message: 'nope' }, 500);
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
    if (operation === 'PullRequestClosingIssues') {
      return json({
        data: {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                pageInfo: { hasNextPage: false },
                nodes: (pull?.closes ?? []).map(({ number, repository = 'forge' }) => ({
                  number,
                  repository: { nameWithOwner: `rameezk/${repository}` },
                })),
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
  const journals: string[] = [];
  const github = withProtectedRepositories(answering, reviewerApp.rules ?? {});
  const fetch = routedThrough(app, github);

  return {
    run: async (): Promise<number> => {
      const { result, journal } = await journaled(() => autoMerge(env, fetch, () => NOW, () => dice.next));
      journals.push(journal);
      return result;
    },
    journals,
    settle: (more: Settled[], fingerprint = COHORT): void => {
      const opened = Store.open(join(stateDir, 'forge.db'));
      try {
        settleHistory(opened, more, fingerprint);
      } finally {
        opened.close();
      }
    },
    withStore: <T>(use: (store: Store) => T): T => {
      const opened = Store.open(join(stateDir, 'forge.db'));
      try {
        return use(opened);
      } finally {
        opened.close();
      }
    },
    closePullRequest: (number: number): void => {
      closedPulls.add(number);
    },
    reopenIssue: (repository: string, number: number): void => {
      const issue = issues.get(`${repository}#${number}`);
      if (issue !== undefined) issue.state = 'open';
    },
    release: (number: number): void => {
      held.delete(number);
    },
    changeHead: (number: number): void => {
      heads.set(number, `moved-${number}`);
    },
    pulls,
    issues,
    issueWrites,
    mergedPulls,
    reviews,
    merges,
    comments,
    removedLabels,
    labels,
    checkRuns,
    dice,
    hooks,
    mints: app.mints,
  };
};

const outcomeOf = (f: ReturnType<typeof forge>, number: number, repository = 'forge'): string | undefined =>
  f.withStore((store) => riskGradeOf(store, repository, number, HEAD(number))?.outcome);

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
  assert.deepEqual([f.reviews, f.merges, f.comments], [[], [], []]);
  assert.deepEqual(f.mints.filter(({ repository }) => repository === 'rameezk/other'), []);
  assert.equal(outcomeOf(f, 1, 'other'), 'open');
});

test('given a pull request whose head changes after the pass checked it, when the merge is attempted, then nothing merges, the grade stays open and the pass reports the failure', async () => {
  const f = forge([{ number: 7 }]);
  f.hooks.beforeMerge = (number) => f.changeHead(number);
  assert.equal(await f.run(), 1);
  assert.deepEqual(f.merges, []);
  assert.deepEqual(f.comments, []);
  assert.equal(outcomeOf(f, 7), 'open');
  assert.equal(f.withStore((store) => autoMergeCandidates(store, ['forge'], NOW).length), 1);
});

test('given an auto-merged grade and a grade merged by a person, when the store settles a merge, then they stay distinct outcomes', async () => {
  const f = forge([{ number: 1 }, { number: 2 }]);
  f.withStore((store) => store.grades.settleRiskGrade({ repository: 'forge', number: 2, headSha: HEAD(2) }, 'merged', NOW));
  await f.run();
  assert.equal(outcomeOf(f, 1), 'auto-merged');
  assert.equal(outcomeOf(f, 2), 'merged');
  assert.equal(f.merges.length, 1);
});

test('given the pass started a merge, when frontier sync then sees the pull request merged, then the grade settles as auto-merged and not merged', async () => {
  const f = forge([{ number: 1 }]);
  f.withStore((store) => {
    store.autoMerge.markAutoMergeStarted({ repository: 'forge', number: 1, headSha: HEAD(1) }, NOW);
    store.grades.settleRiskGrade({ repository: 'forge', number: 1, headSha: HEAD(1) }, 'merged', NOW);
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

test('given a pull request holding more than 100 labels with a maintainer forge:hold past the first page, when the pass runs, then it is not merged', async () => {
  const f = forge([{ number: 7, hold: 'maintainer', otherLabels: 120 }]);
  assert.equal(await f.run(), 0);
  assert.deepEqual([f.reviews, f.merges], [[], []]);
});

test('given held pull requests that are running a revision, graded moderate or carrying an outsider hold, when the pass runs, then a maintainer hold is recorded and an outsider hold is removed without any of them merging', async () => {
  const f = forge([
    { number: 1, hold: 'maintainer', revising: true },
    { number: 2, hold: 'maintainer', level: 'moderate' },
    { number: 3, hold: 'outsider', level: 'moderate' },
  ]);
  assert.equal(await f.run(), 0);
  assert.deepEqual(f.withStore((store) => store.autoMerge.heldPullRequests()), [
    { repository: 'forge', number: 1 },
    { repository: 'forge', number: 2 },
  ]);
  assert.deepEqual(f.removedLabels, [{ number: 3, label: 'forge:hold' }]);
  assert.deepEqual([f.reviews, f.merges], [[], []]);
});

test('given a held pull request whose head then moves past its graded head, when the pass runs again, then the store no longer records it as held', async () => {
  const f = forge([{ number: 7, hold: 'maintainer' }]);
  await f.run();
  assert.deepEqual(f.withStore((store) => store.autoMerge.heldPullRequests()), [{ repository: 'forge', number: 7 }]);
  f.withStore((store) =>
    store.workloads.recordWatchedPullRequests('forge', [
      { number: 7, url: 'https://github.com/rameezk/forge/pull/7', closes: [10], newestFeedbackAt: null, mergeable: 'MERGEABLE' as const, headSha: 'moved-7', draft: false, defaultSha: 'default-a' },
    ]),
  );
  await f.run();
  assert.deepEqual(f.withStore((store) => store.autoMerge.heldPullRequests()), []);
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
    store.grades.recordRiskGrade({ ...riskGradeOf(store, 'forge', 7, HEAD(7))!, headSha: 'moved-7' });
    store.workloads.recordWatchedPullRequests('forge', [{ number: 7, url: 'https://github.com/rameezk/forge/pull/7', closes: [10], newestFeedbackAt: null, mergeable: 'MERGEABLE', headSha: 'moved-7', draft: false, defaultSha: 'default-a' }]);
  });
  assert.equal(await f.run(), 0);
  assert.deepEqual([f.reviews, f.merges], [[], []]);
  assert.equal(f.comments.length, 1);
  assert.deepEqual(labelled(f, 7), ['forge:sampled']);
  assert.equal(f.withStore((store) => pullRequestSampled(store, 'forge', 7)), true);
});

test('given an eligible pull request whose draw did not sample it, when the pass runs, then it auto-merges and a later pass does not redraw it', async () => {
  const f = forge([{ number: 7 }]);
  await f.run();
  assert.deepEqual(merged(f), [7]);
  assert.deepEqual(f.labels, []);
  assert.equal(f.withStore((store) => pullRequestSampled(store, 'forge', 7)), false);
  f.dice.next = SAMPLED;
  await f.run();
  assert.equal(f.withStore((store) => pullRequestSampled(store, 'forge', 7)), false);
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
  assert.equal(f.withStore((store) => pullRequestSampled(store, 'forge', 1)), null);
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

const reviewerFailures = (f: ReturnType<typeof forge>): string[] =>
  f.withStore((store) => store.frontier.reviewerAppFailures('forge'));

test('given an opted-in repository whose rules pass and where the Reviewer App is not installed, when the pass runs, then it merges nothing there, logs why and records that the App is not installed', async () => {
  const f = forge([{ number: 7 }], ['forge'], {}, { installed: ['rameezk/other'] });
  await f.run();

  assert.deepEqual(f.merges, []);
  assert.deepEqual(f.reviews, []);
  assert.deepEqual(reviewerFailures(f), ['the Reviewer App is not installed on it']);
  assert.match(f.journals.join(''), /forge: merges nothing, the Reviewer App is not installed on it/);
});

test('given a Reviewer App installation without Checks write and a pull request that passes every gate, when the pass runs, then the failure names the missing permission and nothing is approved or merged, and it clears once the permission is granted', async () => {
  const unaccepted: Record<string, string> = { checks: 'write' };
  const f = forge([{ number: 7 }], ['forge'], {}, { rules: { 'rameezk/forge': PROTECTED }, unaccepted });
  await f.run();

  assert.deepEqual(f.merges, []);
  assert.deepEqual(f.reviews, []);
  const [failure] = reviewerFailures(f);
  assert.match(failure ?? '', /checks: write/);
  assert.match(f.journals.join(''), /forge: merges nothing, .*checks: write/);

  delete unaccepted.checks;
  await f.run();
  assert.equal(f.merges.length, 1);
  assert.deepEqual(reviewerFailures(f), []);
});

test('given a ruleset the Reviewer App can bypass, when the pass runs, then the pull request is not merged and the failure names the ruleset', async () => {
  const f = forge([{ number: 7 }], ['forge'], {}, { rules: { 'rameezk/forge': bypassable('always') } });
  await f.run();

  assert.deepEqual(f.merges, []);
  assert.deepEqual(reviewerFailures(f), ['the Reviewer App can bypass the ruleset "protect main"']);
});

test('given GitHub answering the Reviewer App check with an error, when the pass runs, then nothing merges and the failure says it could not be checked', async () => {
  const f = forge([{ number: 7 }], ['forge'], {}, { rules: { 'rameezk/forge': unreadable } });
  await f.run();

  assert.deepEqual(f.merges, []);
  const [failure] = reviewerFailures(f);
  assert.match(failure ?? '', /^whether the Reviewer App is set up could not be checked: /);
  assert.match(failure ?? '', /403/);
});

test('given the Reviewer App installed and unable to bypass, when the pass runs, then the pull request merges and no Reviewer App failure is recorded', async () => {
  const f = forge([{ number: 7 }], ['forge'], {}, { rules: { 'rameezk/forge': PROTECTED } });
  await f.run();

  assert.equal(f.merges.length, 1);
  assert.deepEqual(reviewerFailures(f), []);
});

test('given a repository that fails the Reviewer App check and then passes it, when the pass runs again, then the failure clears and the pull request merges', async () => {
  const rules = { 'rameezk/forge': bypassable('always') };
  const f = forge([{ number: 7 }], ['forge'], {}, { rules });
  await f.run();
  assert.deepEqual(f.merges, []);

  rules['rameezk/forge'] = PROTECTED;
  await f.run();
  assert.equal(f.merges.length, 1);
  assert.deepEqual(reviewerFailures(f), []);
});

test('given stored rule failures saying the default branch no longer requires approval of the latest push, when the pass runs, then the pull request is not merged and the pass logs the repository and its failures', async () => {
  const failure = 'its default branch does not require approval of the most recent push';
  const f = forge([{ number: 7 }], ['forge'], {}, { storedRuleFailures: [failure] });
  await f.run();

  assert.deepEqual(f.merges, []);
  assert.ok(f.journals.join('').includes(`forge: merges nothing, ${failure}`));
});

test('given a repository that is not opted in, when the pass runs, then its Reviewer App is not checked', async () => {
  const f = forge([{ number: 7 }], [], {}, { installed: [] });
  await f.run();

  assert.deepEqual(reviewerFailures(f), []);
});

test('given frontier sync last stored a Reviewer App failure that the App has since cleared, when the pass runs, then the stale failure does not stop the merge', async () => {
  const f = forge([{ number: 7 }], ['forge'], {}, { rules: { 'rameezk/forge': PROTECTED } });
  f.withStore((store) => {
    store.frontier.recordReviewerAppFailures('forge', ['the Reviewer App is not installed on it'], NOW);
    store.frontier.recordBranchRules({
      repository: 'forge',
      github: 'rameezk/forge',
      failures: [],
      reviewerApp: ['the Reviewer App is not installed on it'],
    });
  });
  await f.run();

  assert.equal(f.merges.length, 1);
});

test('given 20 settled human-reviewed trivial and low grades in the current cohort of which 17 held up, when the pass runs on an eligible pull request, then it is sampled with the pause named and not merged', async () => {
  const f = forge([{ number: 7 }], ['forge'], {}, {}, [...failed(3), ...held(17)]);
  assert.equal(await f.run(), 0);
  assert.deepEqual(labelled(f, 7), ['forge:sampled']);
  assert.deepEqual([f.reviews, f.merges], [[], []]);
  assert.match(f.comments[0]?.body ?? '', /paused: 17 of the last 20/);
  assert.match(f.comments[0]?.body ?? '', /90%/);
  assert.equal(f.withStore((store) => pullRequestSampled(store, 'forge', 7)), true);
});

test('given a pause that further sampled grades lift until 18 of the last 20 held up, when the pass runs on an eligible unsampled pull request, then it auto-merges', async () => {
  const f = forge([{ number: 7 }, { number: 8, checks: 'pending' }], ['forge'], {}, {}, [...failed(3), ...held(17)]);
  await f.run();
  assert.deepEqual(f.merges, []);
  f.settle(held(1));
  f.pulls[1]!.checks = 'passing';
  assert.equal(await f.run(), 0);
  assert.deepEqual(merged(f), [8]);
  assert.equal(f.withStore((store) => pullRequestSampled(store, 'forge', 7)), true);
});

test('given a cohort whose last 20 settled grades include auto-merged ones, when the pass runs, then only the human-reviewed grades are in the rate', async () => {
  const lifted = forge([{ number: 7 }], ['forge'], {}, {}, [...failed(1), ...held(18), ...Array<Settled>(10).fill('auto')]);
  await lifted.run();
  assert.deepEqual(merged(lifted), [7]);
  const paused = forge([{ number: 7 }], ['forge'], {}, {}, [...failed(3), ...held(17), ...Array<Settled>(10).fill('auto')]);
  await paused.run();
  assert.deepEqual(paused.merges, []);
});

test('given a grading fingerprint change and 9 settled trivial and low grades under the new cohort, all held up, when the pass runs, then the pull request is sampled as warming up, and after the 10th settles the next eligible pull request auto-merges', async () => {
  const fresh = { fingerprint: 'new-cohort' };
  const f = forge([{ number: 7, ...fresh }, { number: 8, checks: 'pending', ...fresh }], ['forge'], {}, {}, held(20));
  f.settle(held(9), 'new-cohort');
  await f.run();
  assert.deepEqual(f.merges, []);
  assert.deepEqual(labelled(f, 7), ['forge:sampled']);
  assert.match(f.comments[0]?.body ?? '', /warming up: 9 of 10/);
  f.settle(held(1), 'new-cohort');
  f.pulls[1]!.checks = 'passing';
  await f.run();
  assert.deepEqual(merged(f), [8]);
});

test('given a cohort with 10 settled grades none of which a person reviewed, when the pass runs, then the pull request is sampled as warming up', async () => {
  const f = forge([{ number: 7 }], ['forge'], {}, {}, Array<Settled>(10).fill('auto'));
  await f.run();
  assert.deepEqual(f.merges, []);
  assert.deepEqual(labelled(f, 7), ['forge:sampled']);
});

test('given a candidate graded low that touches a protected path, when the pass runs, then its head has a completed neutral forge/auto-merge check run naming the protected path, written by the Reviewer App', async () => {
  const f = forge([{ number: 1, files: [edit('.github/workflows/ci.yml')] }]);
  await f.run();
  assert.equal(f.checkRuns.length, 1);
  const [run] = f.checkRuns;
  assert.equal(run?.method, 'POST');
  assert.match(run?.authorization ?? '', /^bearer ghs_review_/i);
  assert.equal(run?.body.name, 'forge/auto-merge');
  assert.equal(run?.body.head_sha, HEAD(1));
  assert.equal(run?.body.status, 'completed');
  assert.equal(run?.body.conclusion, 'neutral');
  assert.equal(run?.body.output.title, 'Waits: it touches the protected path `.github/workflows/ci.yml`');
  assert.match(run?.body.output.summary ?? '', /it touches the protected path `\.github\/workflows\/ci\.yml`/);
});

const titles = (f: ReturnType<typeof forge>): string[] => f.checkRuns.map(({ body }) => body.output.title);

test('given a candidate that touches a protected path and is over the size cap, when the pass runs, then the check run summary names both and its title names the first with +1 more', async () => {
  const f = forge([{ number: 1, files: [edit('.github/workflows/ci.yml', 200, 101)] }]);
  await f.run();
  assert.deepEqual(titles(f), ['Waits: it touches the protected path `.github/workflows/ci.yml`, +1 more']);
  const summary = f.checkRuns[0]?.body.output.summary ?? '';
  assert.match(summary, /it touches the protected path/);
  assert.match(summary, /it changes 301 lines, over the cap of 300/);
});

test('given candidates that are a draft, have a forge workload running or have open feedback, when the pass runs, then each gets a neutral check run naming that gate', async () => {
  const f = forge([
    { number: 1, draft: true },
    { number: 2, revising: true },
    { number: 3, feedback: true },
    { number: 4, unresolvedThread: true },
    { number: 5, checks: 'pending' },
  ]);
  await f.run();
  assert.deepEqual(
    f.checkRuns.map(({ body }) => [body.head_sha, body.conclusion]),
    [1, 2, 3, 4, 5].map((number) => [HEAD(number), 'neutral']),
  );
  assert.deepEqual(titles(f), [
    'Waits: it is a draft',
    'Waits: a forge workload is running on it',
    'Waits: it has open feedback',
    'Waits: it has 1 unresolved review thread',
    'Waits: required checks are pending: `ci`',
  ]);
});

test('given a held-back candidate whose required checks were pending and now fail, when the pass runs, then its existing check run is updated in place and no second run is created', async () => {
  const f = forge([{ number: 1, checks: 'pending' }]);
  await f.run();
  (f.pulls[0] as Pull).checks = 'failing';
  await f.run();
  assert.deepEqual(
    f.checkRuns.map(({ method, id }) => [method, id]),
    [['POST', 1], ['PATCH', 1]],
  );
  assert.equal(f.checkRuns[1]?.body.output.title, 'Waits: required checks fail: `ci`');
});

test('given a held-back candidate whose push brings it over the size cap and whose new head is graded low, when the pass runs, then a new check run on the new head names the size cap and the old head run is untouched', async () => {
  const f = forge([{ number: 1, draft: true }]);
  await f.run();
  f.changeHead(1);
  (f.pulls[0] as Pull).draft = false;
  (f.pulls[0] as Pull).files = [edit('src/a.ts', 200, 101)];
  f.withStore((store) => {
    store.grades.recordRiskGrade({ ...(riskGradeOf(store, 'forge', 1, HEAD(1)) as RiskGrade), headSha: 'moved-1' });
    store.workloads.recordWatchedPullRequests('forge', [
      {
        number: 1,
        url: 'https://github.com/rameezk/forge/pull/1',
        closes: [10],
        newestFeedbackAt: null,
        mergeable: 'MERGEABLE',
        headSha: 'moved-1',
        draft: false,
        defaultSha: 'default-a',
      },
    ]);
  });
  await f.run();
  assert.deepEqual(
    f.checkRuns.map(({ method, id, body }) => [method, id, body.head_sha]),
    [['POST', 1, HEAD(1)], ['POST', 2, 'moved-1']],
  );
  assert.match(f.checkRuns[1]?.body.output.title ?? '', /over the cap of 300/);
});

test('given a held-back candidate whose reason has not changed, when the pass runs again, then it makes no check run write and logs no waits line', async () => {
  const f = forge([{ number: 1, files: [edit('.github/workflows/ci.yml')] }]);
  await f.run();
  await f.run();
  assert.equal(f.checkRuns.length, 1);
  assert.match(f.journals[0] ?? '', /waits, it touches the protected path/);
  assert.doesNotMatch(f.journals[1] ?? '', /waits/);
});

test('given a candidate that passes every gate, when forge merges it, then its check run concludes success titled with the head and the comment is unchanged', async () => {
  const f = forge([{ number: 1 }]);
  await f.run();
  assert.deepEqual(
    f.checkRuns.map(({ method, body }) => [method, body.conclusion, body.output.title]),
    [['POST', 'success', `Auto-merged at ${HEAD(1)}`]],
  );
  assert.equal(f.comments.length, 1);
  assert.match(f.comments[0]?.body ?? '', /Forge auto-merged this pull request/);
  assert.equal(outcomeOf(f, 1), 'auto-merged');
});

test('given a candidate that waited and then passes every gate, when forge merges it, then the same check run is updated to success', async () => {
  const f = forge([{ number: 1, checks: 'pending' }]);
  await f.run();
  (f.pulls[0] as Pull).checks = 'passing';
  await f.run();
  assert.deepEqual(
    f.checkRuns.map(({ method, id, body }) => [method, id, body.conclusion]),
    [['POST', 1, 'neutral'], ['PATCH', 1, 'success']],
  );
});

test('given a candidate whose head moved past its graded head, a pull request graded moderate or uncertain, and one in a repository without autoMerge, when the pass runs, then no check run is written', async () => {
  const f = forge(
    [
      { number: 1, draft: true },
      { number: 2, level: 'moderate', draft: true },
      { number: 3, uncertain: true, draft: true },
      { number: 4, repository: 'other', draft: true },
    ],
    ['forge'],
  );
  f.changeHead(1);
  await f.run();
  assert.deepEqual(f.checkRuns, []);
});

test('given a pull request whose changed file name carries Markdown, when the pass runs, then the check run quotes the name as code', async () => {
  const f = forge([{ number: 1, files: [edit('.github/workflows/[x](https://evil.example)@all`.yml')] }]);
  await f.run();
  assert.equal(
    f.checkRuns[0]?.body.output.title,
    'Waits: it touches the protected path `.github/workflows/[x](https://evil.example)@all\'.yml`',
  );
});

test('given a pull request whose changed file name is very long, when the pass runs, then the check run title stays within 255 characters', async () => {
  const f = forge([{ number: 1, files: [edit(`.github/workflows/${'a'.repeat(400)}.yml`)] }]);
  await f.run();
  assert.equal(Array.from(f.checkRuns[0]?.body.output.title ?? '').length, 255);
});

test('given a merge that succeeds but whose check run cannot be written, when the pass runs, then it reports that the pull request merged and the check run failed', async () => {
  const f = forge([{ number: 1 }]);
  f.hooks.failCheckRuns = true;
  assert.equal(await f.run(), 1);
  assert.equal(f.merges.length, 1);
  assert.match(f.journals[0] ?? '', /merged, but its check run could not be written/);
});

test('given a file name with direction override characters and astral characters at the clip boundary, when the pass runs, then the check run text carries neither a bidi character nor a split surrogate pair', async () => {
  const f = forge([{ number: 1, files: [edit(`.github/workflows/\u202Efdp.yml${'\u{1F600}'.repeat(300)}`)] }]);
  await f.run();
  const { title } = f.checkRuns[0]?.body.output ?? { title: '' };
  assert.doesNotMatch(title, /\u202E/);
  assert.doesNotMatch(title, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  assert.ok(Array.from(title).length <= 255);
});

test('given a merge whose comment cannot be posted, when the pass runs, then the check run still concludes success', async () => {
  const f = forge([{ number: 1 }]);
  f.hooks.failComments = true;
  assert.equal(await f.run(), 1);
  assert.deepEqual(f.checkRuns.map(({ body }) => body.conclusion), ['success']);
});

test('given a pull request with more files than forge can list, when the pass runs, then the summary does not claim the protected paths or Jev gates passed', async () => {
  const files = Array.from({ length: 3000 }, (_, index) => edit(`src/f${index}.ts`, 0, 0));
  const f = forge([{ number: 1, files }]);
  await f.run();
  const summary = f.checkRuns[0]?.body.output.summary ?? '';
  assert.match(summary, /more than forge can list/);
  assert.doesNotMatch(summary, /Protected paths: it touches none/);
  assert.doesNotMatch(summary, /Seen by Jev/);
});

const verdictRuns = (f: ReturnType<typeof forge>): [string, string, string][] =>
  f.checkRuns.map(({ method, body }) => [method, body.conclusion, body.output.title]);

test('given a candidate a maintainer put forge:hold on, when the pass runs, then its head has a neutral check run titled Held by a maintainer', async () => {
  const f = forge([{ number: 1, hold: 'maintainer' }]);
  await f.run();
  assert.deepEqual(verdictRuns(f), [['POST', 'neutral', 'Held by a maintainer']]);
  assert.equal(f.checkRuns[0]?.body.head_sha, HEAD(1));
  assert.equal(f.checkRuns[0]?.body.status, 'completed');
  assert.deepEqual(f.merges, []);
});

test('given a held candidate still held at the same head, when the pass runs again, then it makes no check run write', async () => {
  const f = forge([{ number: 1, hold: 'maintainer' }]);
  await f.run();
  await f.run();
  assert.equal(f.checkRuns.length, 1);
});

test('given a held candidate whose hold is released, when the pass runs, then the same check run is updated to success', async () => {
  const f = forge([{ number: 1, hold: 'maintainer' }]);
  await f.run();
  f.release(1);
  await f.run();
  assert.deepEqual(
    f.checkRuns.map(({ method, id, body }) => [method, id, body.conclusion]),
    [['POST', 1, 'neutral'], ['PATCH', 1, 'success']],
  );
});

test('given held pull requests that are graded moderate or uncertain, or whose head moved on, when the pass runs, then no check run is written', async () => {
  const f = forge([
    { number: 1, hold: 'maintainer' },
    { number: 2, hold: 'maintainer', level: 'moderate' },
    { number: 3, hold: 'maintainer', uncertain: true },
  ]);
  f.changeHead(1);
  await f.run();
  assert.deepEqual(f.checkRuns, []);
});

test('given a candidate that passes every gate and is drawn for the audit sample, when the pass runs, then its check run is neutral, titled Sampled for a maintainer\'s review, with the audit-sample reason', async () => {
  const f = forge([{ number: 7 }]);
  f.dice.next = SAMPLED;
  await f.run();
  assert.deepEqual(verdictRuns(f), [['POST', 'neutral', "Sampled for a maintainer's review"]]);
  const summary = f.checkRuns[0]?.body.output.summary ?? '';
  assert.match(summary, /A random 25% of the pull requests that pass the gates goes to a maintainer/);
  assert.ok((f.comments[0]?.body ?? '').includes(summary.split('\n')[0] ?? 'missing'));
  await f.run();
  assert.equal(f.checkRuns.length, 1);
});

test('given candidates that pass every gate while auto-merge is paused and while it is warming up, when the pass runs, then each check run gives the reason worded as in the sample comment', async () => {
  const paused = forge([{ number: 7 }], ['forge'], {}, {}, [...failed(3), ...held(17)]);
  await paused.run();
  assert.deepEqual(verdictRuns(paused), [['POST', 'neutral', "Sampled for a maintainer's review"]]);
  assert.match(paused.checkRuns[0]?.body.output.summary ?? '', /Auto-merge is paused: 17 of the last 20/);

  const warming = forge([{ number: 7 }], ['forge'], {}, {}, Array<Settled>(10).fill('auto'));
  await warming.run();
  assert.match(warming.checkRuns[0]?.body.output.summary ?? '', /Auto-merge is warming up: 10 of 10/);
});

test('given a candidate in a repository where the Reviewer App can bypass the rules, when the pass runs, then it is not merged and its check run says forge merges nothing in this repository and names the failure', async () => {
  const f = forge([{ number: 7 }], ['forge'], {}, { rules: { 'rameezk/forge': bypassable('always') } });
  await f.run();
  assert.deepEqual(f.merges, []);
  assert.equal(f.checkRuns.length, 1);
  const [run] = f.checkRuns;
  assert.equal(run?.method, 'POST');
  assert.equal(run?.body.conclusion, 'neutral');
  assert.equal(run?.body.head_sha, HEAD(7));
  assert.match(run?.body.output.title ?? '', /merges nothing in this repository/i);
  assert.match(run?.body.output.summary ?? '', /merges nothing in this repository/i);
  assert.match(run?.body.output.summary ?? '', /the Reviewer App can bypass the ruleset "protect main"/);
  assert.match(run?.body.output.summary ?? '', /^- `.*`$/m);
  await f.run();
  assert.equal(f.checkRuns.length, 1);
});

test('given a repository that stops failing its rules, when the pass runs again, then the same check run is updated', async () => {
  const rules = { 'rameezk/forge': bypassable('always') };
  const f = forge([{ number: 7 }], ['forge'], {}, { rules });
  await f.run();
  rules['rameezk/forge'] = PROTECTED;
  await f.run();
  assert.deepEqual(
    f.checkRuns.map(({ method, id, body }) => [method, id, body.conclusion]),
    [['POST', 1, 'neutral'], ['PATCH', 1, 'success']],
  );
});

test('given a candidate in a repository whose Reviewer App lacks Checks write or is not installed, when the pass runs, then no check run write is attempted', async () => {
  const missing = forge([{ number: 7 }], ['forge'], {}, { rules: { 'rameezk/forge': PROTECTED }, unaccepted: { checks: 'write' } });
  await missing.run();
  assert.deepEqual(missing.checkRuns, []);
  const uninstalled = forge([{ number: 7 }], ['forge'], {}, { installed: [] });
  await uninstalled.run();
  assert.deepEqual(uninstalled.checkRuns, []);
});

test('given a failing repository whose candidate head moved on or that is not a candidate, when the pass runs, then no check run is written', async () => {
  const f = forge(
    [{ number: 1 }, { number: 2, level: 'moderate' }, { number: 3, repository: 'other' }],
    ['forge'],
    {},
    { rules: { 'rameezk/forge': bypassable('always') } },
  );
  f.changeHead(1);
  await f.run();
  assert.deepEqual(f.checkRuns, []);
});

const closes = (...numbers: number[]): ClosingIssue[] => numbers.map((number) => ({ number }));

const stateOf = (f: ReturnType<typeof forge>, number: number, repository = 'forge'): string | undefined =>
  f.issues.get(`${repository}#${number}`)?.state;

const owedOf = (f: ReturnType<typeof forge>) => f.withStore((store) => store.autoMerge.owedCloses(['forge', 'other']));

test('given a candidate that passes every gate and closes two open issues in its repository, when the pass auto-merges it, then both issues are closed as completed with no comment and their labels unchanged', async () => {
  const f = forge([{ number: 7, closes: closes(10, 11) }]);
  assert.equal(await f.run(), 0);

  assert.deepEqual(f.issueWrites, [
    { repository: 'forge', number: 10, body: { state: 'closed', state_reason: 'completed' } },
    { repository: 'forge', number: 11, body: { state: 'closed', state_reason: 'completed' } },
  ]);
  assert.equal(stateOf(f, 10), 'closed');
  assert.equal(stateOf(f, 11), 'closed');
  assert.deepEqual(f.issues.get('forge#10')?.labels, ['ready-for-agent', 'forge:done']);
  assert.deepEqual(f.comments.map(({ number }) => number), [7]);
  assert.deepEqual(f.labels, []);
  assert.deepEqual(owedOf(f), []);
});

test('given closing references that include an already closed issue and an issue in another repository, when the pass auto-merges the pull request, then neither is touched and the open same-repository references are closed', async () => {
  const f = forge([
    { number: 7, closes: [{ number: 10 }, { number: 11, state: 'closed' }, { number: 12, repository: 'other' }] },
  ]);
  assert.equal(await f.run(), 0);

  assert.deepEqual(f.issueWrites.map(({ repository, number }) => `${repository}#${number}`), ['forge#10']);
  assert.equal(stateOf(f, 12, 'other'), 'open');
  assert.deepEqual(owedOf(f), []);
});

test('given a pass that merges a pull request but whose close of one issue fails, when it finishes, then the check run and the comment are written, the pass fails, and the next pass closes the issue', async () => {
  const f = forge([{ number: 7, closes: closes(10, 11) }]);
  f.hooks.failIssueCloses.add(11);
  assert.equal(await f.run(), 1);

  assert.equal(stateOf(f, 10), 'closed');
  assert.equal(stateOf(f, 11), 'open');
  assert.equal(f.checkRuns.length, 1);
  assert.equal(f.comments.length, 1);
  assert.match(f.journals.join(''), /forge#7: could not auto-merge: .*11/);

  f.hooks.failIssueCloses.clear();
  assert.equal(await f.run(), 0);
  assert.equal(stateOf(f, 11), 'closed');
  assert.deepEqual(f.issueWrites.map(({ number }) => number), [10, 11]);
  assert.deepEqual(owedOf(f), []);
});

test('given a pull request that merged but whose pass stopped at the merge call, when the next pass runs on the same store, then its closing issues are closed', async () => {
  const f = forge([{ number: 7, closes: closes(10) }]);
  f.hooks.beforeMerge = (number) => {
    f.mergedPulls.add(number);
    throw new Error('connection reset');
  };
  assert.equal(await f.run(), 1);
  assert.equal(stateOf(f, 10), 'open');
  assert.deepEqual(owedOf(f), [{ repository: 'forge', number: 7, issues: [10] }]);

  f.hooks.beforeMerge = () => {};
  assert.equal(await f.run(), 0);
  assert.equal(stateOf(f, 10), 'closed');
  assert.deepEqual(owedOf(f), []);
});

test('given owed closes for a pull request whose merge call failed and which is still open, when the next pass runs, then none of its issues are closed and the owed closes are dropped', async () => {
  const f = forge([{ number: 7, closes: closes(10) }]);
  f.hooks.refuseMerges = true;
  assert.equal(await f.run(), 1);
  assert.deepEqual(owedOf(f), [{ repository: 'forge', number: 7, issues: [10] }]);

  f.changeHead(7);
  await f.run();
  assert.deepEqual(f.issueWrites, []);
  assert.deepEqual(owedOf(f), []);
});

test('given owed closes for a pull request closed without merging, when the next pass runs, then none of its issues are closed and the owed closes are dropped', async () => {
  const f = forge([{ number: 7, closes: closes(10) }]);
  f.hooks.refuseMerges = true;
  await f.run();
  f.closePullRequest(7);

  await f.run();
  assert.deepEqual(f.issueWrites, []);
  assert.equal(stateOf(f, 10), 'open');
  assert.deepEqual(owedOf(f), []);
});

test('given a ticket forge closed after an auto-merge that a maintainer reopened, when later passes run, then the ticket stays open', async () => {
  const f = forge([{ number: 7, closes: closes(10) }]);
  await f.run();
  f.reopenIssue('forge', 10);

  await f.run();
  await f.run();
  assert.equal(stateOf(f, 10), 'open');
  assert.equal(f.issueWrites.length, 1);
});

test('given owed closes for a repository whose Reviewer App rules now fail, when a pass runs and later one runs after the rules pass again, then the first closes nothing and the later closes the issues', async () => {
  const unaccepted: Record<string, string> = {};
  const f = forge([{ number: 7, closes: closes(10) }], ['forge'], {}, { unaccepted });
  f.hooks.beforeMerge = (number) => {
    f.mergedPulls.add(number);
    throw new Error('connection reset');
  };
  await f.run();
  f.hooks.beforeMerge = () => {};

  unaccepted.issues = 'write';
  await f.run();
  assert.deepEqual(f.issueWrites, []);
  assert.equal(owedOf(f).length, 1);

  delete unaccepted.issues;
  assert.equal(await f.run(), 0);
  assert.equal(stateOf(f, 10), 'closed');
});

test('given a Reviewer App installation without Issues write, when the pass runs, then nothing merges and the failure names the missing permission', async () => {
  const f = forge([{ number: 7, closes: closes(10) }], ['forge'], {}, { rules: { 'rameezk/forge': PROTECTED }, unaccepted: { issues: 'write' } });
  await f.run();

  assert.deepEqual(f.merges, []);
  assert.deepEqual(f.issueWrites, []);
  const [failure] = reviewerFailures(f);
  assert.match(failure ?? '', /issues: write/);
});
