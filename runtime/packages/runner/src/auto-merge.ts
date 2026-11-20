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
  candidatesWithFacts,
  autoMergeStatus,
  drawSample,
  FORGE_SAMPLED,
  queryPullRequestReadiness,
  queryUnresolvedThreads,
  relabel,
  type AutoMergeStatus,
  type AutoMergeVerdict,
  type CandidateFacts,
  type CheckRunConclusion,
  type FailingGate,
  type GateKey,
  type Fetch,
  type InstallationTokens,
  type RecordedRiskGrade,
  type Store,
} from '@forge/shared';

export const CHECK_NAME = 'forge/auto-merge';

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

const TITLE_LIMIT = 255;

const SUMMARY_LIMIT = 65535;

const clip = (text: string, limit: number): string => {
  const characters = Array.from(text);
  return characters.length <= limit ? text : `${characters.slice(0, limit - 1).join('')}…`;
};

const code = (name: string): string => `\`${name.replaceAll('`', "'").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')}\``;

export interface DiffFacts {
  changedLines: number;
  sizeCap: number;
}

type GateGroup = 'settled' | 'checks' | 'feedback' | 'hold' | 'protected-paths' | 'size' | 'seen';

const GATE_GROUP: Record<GateKey, GateGroup> = {
  draft: 'settled',
  working: 'settled',
  mergeability: 'settled',
  'checks-failing': 'checks',
  'checks-pending': 'checks',
  feedback: 'feedback',
  'protected-path': 'protected-paths',
  'too-many-files': 'size',
  size: 'size',
  'not-seen': 'seen',
};

const passedWording = ({ changedLines, sizeCap }: DiffFacts): [GateGroup, string][] => [
  ['settled', 'Settled: not a draft, and no forge workload is running on it.'],
  ['checks', 'Checks: every required check is green.'],
  ['feedback', 'Feedback: no open feedback and no unresolved review threads.'],
  ['hold', 'Hold: no maintainer has put forge:hold on it.'],
  ['protected-paths', 'Protected paths: it touches none.'],
  ['size', `Size: ${changedLines} changed lines, within the cap of ${sizeCap}.`],
  ['seen', 'Seen by Jev: Jev saw every changed file.'],
];

export const gatesPassed = (facts: DiffFacts, failing: readonly FailingGate[] = []): string[] => {
  const failed = new Set(failing.map(({ key }) => GATE_GROUP[key]));
  return passedWording(facts)
    .filter(([group]) => !failed.has(group))
    .map(([, wording]) => wording);
};

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

interface Evaluation {
  facts: DiffFacts;
  gates: FailingGate[];
}

const evaluate = async (
  { fetch }: AutoMergeOptions,
  token: string,
  repository: string,
  { grade, ...known }: CandidateFacts,
  config: RepositoryConfig,
): Promise<Evaluation | string> => {
  const pull = (await github(fetch, token, `/repos/${repository}/pulls/${grade.number}`)) as {
    state: string;
    draft: boolean;
    head: { sha: string };
  };
  if (pull.state !== 'open') return 'it is not open';
  if (pull.head.sha !== grade.headSha) return 'its head moved on from the graded head';
  const readiness = await queryPullRequestReadiness(fetch, token, repository, grade.number);
  const threads = await queryUnresolvedThreads(fetch, token, repository, grade.number);
  const files = await changedFiles(fetch, token, repository, grade.number);
  const gates: FailingGate[] = [];
  const fail = (key: GateKey, detail: string): void => {
    gates.push({ key, detail });
  };
  if (pull.draft || known.draft || readiness.draft) fail('draft', 'it is a draft');
  if (known.workloadRunning) fail('working', 'a forge workload is running on it');
  if (!known.mergeable) fail('mergeability', 'its mergeability is not known yet');
  if (readiness.failing.length > 0) fail('checks-failing', `required checks fail: ${readiness.failing.map(code).join(', ')}`);
  if (readiness.pending.length > 0) fail('checks-pending', `required checks are pending: ${readiness.pending.map(code).join(', ')}`);
  const feedback = [
    ...(known.feedbackOpen ? ['it has open feedback'] : []),
    ...(threads > 0 ? [`it has ${threads} unresolved review thread${threads === 1 ? '' : 's'}`] : []),
  ];
  if (feedback.length > 0) fail('feedback', feedback.join(' and '));
  const protectedPath = touchedProtectedPath(files, protectedPathsOf(config));
  if (protectedPath !== null) fail('protected-path', `it touches the protected path ${code(protectedPath)}`);
  if (files.length >= MAX_CHANGED_FILES) {
    fail('too-many-files', `it changes ${MAX_CHANGED_FILES} files or more, more than forge can list`);
  }
  const hidden = files.find((file) => !shownToJev(file));
  if (hidden !== undefined) fail('not-seen', `Jev did not see the content of ${code(hidden.filename)}`);
  const changedLines = files.reduce((sum, { additions, deletions }) => sum + additions + deletions, 0);
  const sizeCap = sizeCapOf(config);
  if (changedLines > sizeCap) fail('size', `it changes ${changedLines} lines, over the cap of ${sizeCap}`);
  return { facts: { changedLines, sizeCap }, gates };
};

const verdictOutput = (
  grade: RecordedRiskGrade,
  verdict: AutoMergeVerdict,
  facts: DiffFacts,
): { title: string; summary: string } => {
  if (verdict.kind === 'auto-merged') {
    return {
      title: `Auto-merged at ${grade.headSha}`,
      summary: ['Gates passed:', ...gatesPassed(facts).map((gate) => `- ${gate}`)].join('\n'),
    };
  }
  const [first, ...others] = verdict.gates;
  return {
    title: clip(`Waits: ${first?.detail ?? ''}${others.length > 0 ? `, +${others.length} more` : ''}`, TITLE_LIMIT),
    summary: clip([
      'Forge will not auto-merge this pull request until:',
      ...verdict.gates.map(({ detail }) => `- ${detail}`),
      '',
      'Gates passed:',
      ...gatesPassed(facts, verdict.gates).map((gate) => `- ${gate}`),
    ].join('\n'), SUMMARY_LIMIT),
  };
};

const publishVerdict = async (
  { store, fetch }: AutoMergeOptions,
  token: string,
  grade: RecordedRiskGrade,
  repository: string,
  verdict: AutoMergeVerdict,
  facts: DiffFacts,
): Promise<boolean> => {
  const conclusion: CheckRunConclusion = verdict.kind === 'auto-merged' ? 'success' : 'neutral';
  const known = store.autoMergeVerdict(grade.repository, grade.number, grade.headSha);
  if (known !== null && known.conclusion === conclusion && JSON.stringify(known.verdict) === JSON.stringify(verdict)) {
    return false;
  }
  const body = { status: 'completed', conclusion, output: verdictOutput(grade, verdict, facts) };
  const written = (await (known === null
    ? github(fetch, token, `/repos/${repository}/check-runs`, {
        method: 'POST',
        body: { name: CHECK_NAME, head_sha: grade.headSha, ...body },
      })
    : github(fetch, token, `/repos/${repository}/check-runs/${known.checkRunId}`, { method: 'PATCH', body }))) as {
    id: number;
  };
  store.recordAutoMergeVerdict(grade.repository, grade.number, grade.headSha, {
    verdict,
    conclusion,
    checkRunId: written.id,
  });
  return true;
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
  candidate: CandidateFacts | undefined,
): Promise<void> => {
  const { store, fetch, tokens, now, log } = options;
  const repository = config.github;
  const token = await tokens(repository, 'review');
  if (await maintainerHolds(options, token, grade, repository)) {
    log(`${grade.repository}#${grade.number}: waits, a maintainer holds it`);
    return;
  }
  if (candidate === undefined) return;
  const evaluation = await evaluate(options, token, repository, candidate, config);
  if (typeof evaluation === 'string') {
    log(`${grade.repository}#${grade.number}: waits, ${evaluation}`);
    return;
  }
  const { facts, gates } = evaluation;
  if (gates.length > 0) {
    if (await publishVerdict(options, token, grade, repository, { kind: 'waits', gates }, facts)) {
      log(`${grade.repository}#${grade.number}: waits, ${gates.map(({ detail }) => detail).join('; ')}`);
    }
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
  const checkRunFailure = await publishVerdict(options, token, grade, repository, { kind: 'auto-merged' }, facts).then(
    () => null,
    (error: unknown) => error,
  );
  await github(fetch, token, `/repos/${repository}/issues/${grade.number}/comments`, {
    method: 'POST',
    body: { body: autoMergeComment(grade, facts) },
  });
  if (checkRunFailure !== null) {
    throw new Error(`the pull request merged, but its check run could not be written: ${errorMessage(checkRunFailure)}`);
  }
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
  const candidates = new Map(
    candidatesWithFacts(store, names, now()).map((facts) => [`${facts.grade.repository}#${facts.grade.number}`, facts]),
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
        candidates.get(`${grade.repository}#${grade.number}`),
      );
    } catch (error) {
      log(`${grade.repository}#${grade.number}: could not auto-merge: ${errorMessage(error)}`);
      succeeded = false;
    }
  }
  return succeeded;
};
