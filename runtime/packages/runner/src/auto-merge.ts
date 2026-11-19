import {
  changedFiles,
  MAX_CHANGED_FILES,
  shownToJev,
} from './grading.ts';
import type { RepositoryConfig } from './config.ts';
import { protectedPathsOf, sizeCapOf, touchedProtectedPath } from './protected-paths.ts';
import {
  errorMessage,
  FORGE_SAMPLED,
  queryPullRequestReadiness,
  queryUnresolvedThreads,
  relabel,
  type Fetch,
  type InstallationTokens,
  type RecordedRiskGrade,
  type Store,
} from '@forge/shared';

const GITHUB_REST_API = 'https://api.github.com';

export const MERGE_METHOD = 'squash';

export const SAMPLE_RATE = 0.25;

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

export const sampleComment = (grade: RecordedRiskGrade, facts: DiffFacts): string =>
  [
    `Forge would have auto-merged this pull request at \`${grade.headSha}\`, but it was sampled: a maintainer reviews it so trivial and low grades keep being judged. Forge will not merge it.`,
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

const autoMergeOne = async (
  options: AutoMergeOptions,
  grade: RecordedRiskGrade,
  config: RepositoryConfig,
): Promise<void> => {
  const { store, fetch, tokens, now, log } = options;
  const repository = config.github;
  const token = await tokens(repository, 'review');
  const facts = await settled(options, token, repository, grade, config);
  if (typeof facts === 'string') {
    log(`${grade.repository}#${grade.number}: waits, ${facts}`);
    return;
  }
  const sampled = store.drawSample(grade.repository, grade.number, () => drawsSample(options.random), now());
  if (sampled) {
    await relabel(fetch, token, repository, grade.number, FORGE_SAMPLED, []);
    await github(fetch, token, `/repos/${repository}/issues/${grade.number}/comments`, {
      method: 'POST',
      body: { body: sampleComment(grade, facts) },
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

export const autoMergePullRequests = async (options: AutoMergeOptions): Promise<boolean> => {
  const { store, repositories, now, log } = options;
  let succeeded = true;
  for (const grade of store.autoMergeCandidates(Object.keys(repositories), now())) {
    try {
      await autoMergeOne(options, grade, repositories[grade.repository] as RepositoryConfig);
    } catch (error) {
      log(`${grade.repository}#${grade.number}: could not auto-merge: ${errorMessage(error)}`);
      succeeded = false;
    }
  }
  return succeeded;
};
