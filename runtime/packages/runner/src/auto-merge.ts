import {
  errorMessage,
  queryPullRequestReadiness,
  queryUnresolvedThreads,
  type Fetch,
  type InstallationTokens,
  type RecordedRiskGrade,
  type Store,
} from '@forge/shared';

const GITHUB_REST_API = 'https://api.github.com';

export const MERGE_METHOD = 'squash';

export interface AutoMergeOptions {
  store: Store;
  fetch: Fetch;
  tokens: InstallationTokens;
  repositories: Record<string, string>;
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

export const GATES_PASSED = [
  'Settled: not a draft, and no forge workload is running on it.',
  'Checks: every required check is green.',
  'Feedback: no open feedback and no unresolved review threads.',
] as const;

export const autoMergeComment = (grade: RecordedRiskGrade): string =>
  [
    `Forge auto-merged this pull request at \`${grade.headSha}\`.`,
    '',
    `Risk grade: ${grade.level}, confidence ${grade.confidence.toFixed(2)}.`,
    '',
    'Gates passed:',
    ...GATES_PASSED.map((gate) => `- ${gate}`),
  ].join('\n');

const settled = async (
  { fetch }: AutoMergeOptions,
  token: string,
  repository: string,
  grade: RecordedRiskGrade,
): Promise<string | null> => {
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
  return null;
};

const autoMergeOne = async (
  options: AutoMergeOptions,
  grade: RecordedRiskGrade,
  repository: string,
): Promise<void> => {
  const { store, fetch, tokens, now, log } = options;
  const token = await tokens(repository, 'review');
  const waiting = await settled(options, token, repository, grade);
  if (waiting !== null) {
    log(`${grade.repository}#${grade.number}: waits, ${waiting}`);
    return;
  }
  const path = `/repos/${repository}/pulls/${grade.number}`;
  await github(fetch, token, `${path}/reviews`, {
    method: 'POST',
    body: { commit_id: grade.headSha, event: 'APPROVE' },
  });
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
    body: { body: autoMergeComment(grade) },
  });
};

export const autoMergePullRequests = async (options: AutoMergeOptions): Promise<boolean> => {
  const { store, repositories, now, log } = options;
  let succeeded = true;
  for (const grade of store.autoMergeCandidates(Object.keys(repositories), now())) {
    try {
      await autoMergeOne(options, grade, repositories[grade.repository] as string);
    } catch (error) {
      log(`${grade.repository}#${grade.number}: could not auto-merge: ${errorMessage(error)}`);
      succeeded = false;
    }
  }
  return succeeded;
};
