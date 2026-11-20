import {
  changedFiles,
  MAX_CHANGED_FILES,
  shownToJev,
} from './grading.ts';
import type { RepositoryConfig } from './config.ts';
import { protectedPathsOf, sizeCapOf, touchedProtectedPath } from './protected-paths.ts';
import {
  errorMessage,
  FORGE_HOLD,
  holdOn,
  maintainerLookup,
  checkReviewerApp,
  PAUSE_BAR_PERCENT,
  SAMPLE_RATE,
  WARM_UP_SETTLED,
  removeLabel,
  autoMergeCandidates,
  autoMergeStatus,
  drawSample,
  FORGE_SAMPLED,
  queryPullRequestReadiness,
  queryUnresolvedThreads,
  relabel,
  type AutoMergeStatus,
  type Fetch,
  type InstallationTokens,
  type RecordedRiskGrade,
  type Store,
} from '@forge/shared';

const GITHUB_REST_API = 'https://api.github.com';

export const MERGE_METHOD = 'squash';

export const drawsSample = (random: () => number): boolean => random() < SAMPLE_RATE;

export interface AutoMergeOptions {
  store: Store;
  fetch: Fetch;
  tokens: InstallationTokens;
  repositories: Record<string, RepositoryConfig>;
  reviewerLogin: () => Promise<string>;
  random: () => number;
  now: () => string;
  log: (line: string) => void;
}

const github = async (
  fetch: Fetch,
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<unknown> => {
  const response = await fetch(`${GITHUB_REST_API}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for ${init.method ?? 'GET'} ${path}`);
  }
  return response.json();
};

export interface DiffFacts {
  changedLines: number;
  sizeCap: number;
}

export const gatesPassed = ({ changedLines, sizeCap }: DiffFacts): string[] => [
  'Settled: not a draft, and no forge workload is running on it.',
  'Checks: every required check is green.',
  'Feedback: no open feedback and no unresolved review threads.',
  'Hold: no maintainer has put forge:hold on it.',
  'Protected paths: it touches none.',
  `Size: ${changedLines} changed lines, within the cap of ${sizeCap}.`,
  'Seen by Jev: Jev saw every changed file.',
];

export const autoMergeComment = (grade: RecordedRiskGrade, facts: DiffFacts): string =>
  [
    `Forge auto-merged this pull request at \`${grade.headSha}\`.`,
    '',
    `Risk grade: ${grade.level}, confidence ${grade.confidence.toFixed(2)}.`,
    '',
    'Gates passed:',
    ...gatesPassed(facts).map((gate) => `- ${gate}`),
  ].join('\n');

const sampleReason = ({ state, settled, heldUp, judged }: AutoMergeStatus): string => {
  if (state === 'paused') {
    return `Auto-merge is paused: ${heldUp} of the last ${judged} settled human-reviewed trivial and low grades held up, below the ${PAUSE_BAR_PERCENT}% bar, so every pull request that passes the gates goes to a maintainer.`;
  }
  if (state === 'warming-up') {
    return `Auto-merge is warming up: ${settled} of ${WARM_UP_SETTLED} trivial and low grades of the current grading cohort have settled, so every pull request that passes the gates goes to a maintainer.`;
  }
  return `A random ${SAMPLE_RATE * 100}% of the pull requests that pass the gates goes to a maintainer so trivial and low grades keep being judged.`;
};

export const sampleComment = (grade: RecordedRiskGrade, facts: DiffFacts, status: AutoMergeStatus): string =>
  [
    `Forge would have auto-merged this pull request at \`${grade.headSha}\`, but it was sampled: a maintainer reviews it. Forge will not merge it.`,
    '',
    sampleReason(status),
    '',
    `Risk grade: ${grade.level}, confidence ${grade.confidence.toFixed(2)}.`,
    '',
    'Gates passed:',
    ...gatesPassed(facts).map((gate) => `- ${gate}`),
  ].join('\n');

const settled = async (
  { fetch }: AutoMergeOptions,
  token: string,
  repository: string,
  grade: RecordedRiskGrade,
  config: RepositoryConfig,
): Promise<DiffFacts | string> => {
  const pull = (await github(fetch, token, `/repos/${repository}/pulls/${grade.number}`)) as {
    state: string;
    draft: boolean;
    head: { sha: string };
  };
  if (pull.state !== 'open') return 'it is not open';
  if (pull.draft) return 'it is a draft';
  if (pull.head.sha !== grade.headSha) return 'its head moved on from the graded head';
  const readiness = await queryPullRequestReadiness(fetch, token, repository, grade.number);
  if (readiness.draft) return 'it is a draft';
  if (readiness.failing.length > 0) return `required checks fail: ${readiness.failing.join(', ')}`;
  if (readiness.pending.length > 0) return `required checks are pending: ${readiness.pending.join(', ')}`;
  const threads = await queryUnresolvedThreads(fetch, token, repository, grade.number);
  if (threads > 0) return `it has ${threads} unresolved review thread${threads === 1 ? '' : 's'}`;
  const files = await changedFiles(fetch, token, repository, grade.number);
  if (files.length >= MAX_CHANGED_FILES) return `it changes ${MAX_CHANGED_FILES} files or more, more than forge can list`;
  const protectedPath = touchedProtectedPath(files, protectedPathsOf(config));
  if (protectedPath !== null) return `it touches the protected path ${protectedPath}`;
  const hidden = files.find((file) => !shownToJev(file));
  if (hidden !== undefined) return `Jev did not see the content of ${hidden.filename}`;
  const changedLines = files.reduce((sum, { additions, deletions }) => sum + additions + deletions, 0);
  const sizeCap = sizeCapOf(config);
  if (changedLines > sizeCap) return `it changes ${changedLines} lines, over the cap of ${sizeCap}`;
  return { changedLines, sizeCap };
};

const approvedBy = async (
  fetch: Fetch,
  token: string,
  path: string,
  headSha: string,
  login: string,
): Promise<boolean> => {
  const reviews = (await github(fetch, token, `${path}/reviews?per_page=100`)) as {
    state: string;
    commit_id: string;
    user: { login: string } | null;
  }[];
  return reviews.some(
    ({ state, commit_id, user }) => state === 'APPROVED' && commit_id === headSha && user?.login.toLowerCase() === login.toLowerCase(),
  );
};

const maintainerHolds = async (
  { store, fetch, log }: AutoMergeOptions,
  token: string,
  grade: RecordedRiskGrade,
  repository: string,
): Promise<boolean> => {
  const hold = await holdOn(fetch, token, repository, grade.number, maintainerLookup(fetch, token, repository));
  if (hold === 'outsider') {
    await removeLabel(fetch, token, repository, grade.number, FORGE_HOLD);
    log(`${grade.repository}#${grade.number}: removed ${FORGE_HOLD}, it was not applied by a maintainer`);
  }
  store.recordHold(grade.repository, grade.number, hold === 'maintainer');
  return hold === 'maintainer';
};

const autoMergeOne = async (
  options: AutoMergeOptions,
  grade: RecordedRiskGrade,
  config: RepositoryConfig,
  candidate: boolean,
): Promise<void> => {
  const { store, fetch, tokens, now, log } = options;
  const repository = config.github;
  const token = await tokens(repository, 'review');
  if (await maintainerHolds(options, token, grade, repository)) {
    log(`${grade.repository}#${grade.number}: waits, a maintainer holds it`);
    return;
  }
  if (!candidate) return;
  const facts = await settled(options, token, repository, grade, config);
  if (typeof facts === 'string') {
    log(`${grade.repository}#${grade.number}: waits, ${facts}`);
    return;
  }
  const status = autoMergeStatus(store);
  const sampled = drawSample(store, grade.repository, grade.number, () => drawsSample(options.random), now(), status.state !== 'live');
  if (sampled) {
    await relabel(fetch, token, repository, grade.number, FORGE_SAMPLED, []);
    await github(fetch, token, `/repos/${repository}/issues/${grade.number}/comments`, {
      method: 'POST',
      body: { body: sampleComment(grade, facts, status) },
    });
    store.markSampleAnnounced(grade.repository, grade.number);
    log(`${grade.repository}#${grade.number}: sampled for a maintainer's review at ${grade.headSha}`);
    return;
  }
  const path = `/repos/${repository}/pulls/${grade.number}`;
  if (!(await approvedBy(fetch, token, path, grade.headSha, await options.reviewerLogin()))) {
    await github(fetch, token, `${path}/reviews`, {
      method: 'POST',
      body: { commit_id: grade.headSha, event: 'APPROVE' },
    });
  }
  store.markAutoMergeStarted(grade, now());
  try {
    await github(fetch, token, `${path}/merge`, {
      method: 'PUT',
      body: { sha: grade.headSha, merge_method: MERGE_METHOD },
    });
  } catch (error) {
    store.clearAutoMergeStarted(grade);
    throw error;
  }
  store.settleRiskGrade(grade, 'merged', now());
  log(`${grade.repository}#${grade.number}: auto-merged at ${grade.headSha}`);
  await github(fetch, token, `/repos/${repository}/issues/${grade.number}/comments`, {
    method: 'POST',
    body: { body: autoMergeComment(grade, facts) },
  });
};

const checkReviewerAppRules = async (
  { store, fetch, tokens, now }: AutoMergeOptions,
  repository: string,
  config: RepositoryConfig,
): Promise<string[]> => {
  const failures = await checkReviewerApp(fetch, config.github, () => tokens(config.github, 'review'));
  store.recordReviewerAppFailures(repository, failures, now());
  return [...store.ownRuleFailures(repository), ...failures];
};

export const autoMergePullRequests = async (options: AutoMergeOptions): Promise<boolean> => {
  const { store, repositories, now, log } = options;
  let succeeded = true;
  const names: string[] = [];
  for (const [repository, config] of Object.entries(repositories)) {
    const failures = await checkReviewerAppRules(options, repository, config);
    if (failures.length === 0) names.push(repository);
    else log(`${repository}: merges nothing, ${failures.join('; ')}`);
  }
  const tracked = store.openGradedPullRequests(names);
  const candidates = new Set(
    autoMergeCandidates(store, names, now()).map(({ repository, number }) => `${repository}#${number}`),
  );
  for (const repository of names) {
    store.keepHolds(
      repository,
      tracked.filter((grade) => grade.repository === repository).map(({ number }) => number),
    );
  }
  for (const grade of tracked) {
    try {
      await autoMergeOne(
        options,
        grade,
        repositories[grade.repository] as RepositoryConfig,
        candidates.has(`${grade.repository}#${grade.number}`),
      );
    } catch (error) {
      log(`${grade.repository}#${grade.number}: could not auto-merge: ${errorMessage(error)}`);
      succeeded = false;
    }
  }
  return succeeded;
};
