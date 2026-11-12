import { createHash } from 'node:crypto';
import {
  errorMessage,
  queryTicketContext,
  notGradedTitle,
  RETRIED_GRADING_FAILURES,
  RISK_LEVELS,
  type ContextIssue,
  type Fetch,
  type GradingAttempt,
  type GradingDue,
  type GradingFailure,
  type InstallationTokens,
  type RiskGrade,
  type RiskLevel,
  type Store,
} from '@forge/shared';

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

export const CHECK_NAME = 'forge/risk';

export const RISK_LABEL_PREFIX = 'forge:risk-';

export const UNSETTLED_LABEL = `${RISK_LABEL_PREFIX}unsettled`;

export const riskLabels = (grade: Pick<RiskGrade, 'level' | 'unsettled'>): string[] => [
  `${RISK_LABEL_PREFIX}${grade.level}`,
  ...(grade.unsettled ? [UNSETTLED_LABEL] : []),
];

export const QUESTION_NAME = 'risk';

export const QUESTION =
  'How much careful human review does this pull request need before it ships? Judge by risk and blast radius against what the ticket and its parent spec asked for.';

export const LEVEL_DESCRIPTIONS: Record<RiskLevel, string> = {
  trivial:
    'docs, comments, config values or tests only; nothing a user or operator could notice breaking',
  low: 'small, contained code change with tests; failure would be obvious and easy to revert',
  moderate:
    'changes behaviour across several components, touches persistence, CI or security-adjacent code, or is hard to verify from tests alone',
  high: 'changes data formats or migrations, sandboxing, credentials, billing, concurrency or anything hard to roll back; failure could be silent or costly',
};

const CRITERIA = RISK_LEVELS.map((level) => `${level}: ${LEVEL_DESCRIPTIONS[level]}`);

export const gradingFingerprint = (model: string): string =>
  `${model}:${createHash('sha256')
    .update(JSON.stringify({ question: QUESTION, criteria: CRITERIA }))
    .digest('hex')}`;

const GITHUB_REST_API = 'https://api.github.com';

const FILES_PAGE_SIZE = 100;

const MAX_FILES_PAGES = 30;

const DECISION_TIMEOUT_MS = 300_000;

const LEFT_OUT =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|go\.sum|[^/]*\.lock)$|\.min\.(js|css)$|\.generated\.|(^|\/)generated\/|\.pb\.go$|_pb2\.py$/;

export interface ChangedFile {
  filename: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export const gradingInput = (
  ticket: ContextIssue,
  spec: ContextIssue | null,
  files: readonly ChangedFile[],
): string => {
  const issue = (label: string, { number, title, body }: ContextIssue): string =>
    `# ${label} #${number}: ${title}\n\n${body}`;
  return [
    issue('Ticket', ticket),
    ...(spec === null ? [] : [issue('Parent spec', spec)]),
    `# Changed files\n\n${files
      .map(
        ({ filename, additions, deletions }) =>
          `${filename} +${additions} -${deletions}${LEFT_OUT.test(filename) ? ' (diff left out)' : ''}`,
      )
      .join('\n')}`,
    `# Diff\n\n${files
      .filter(({ filename, patch }) => !LEFT_OUT.test(filename) && patch !== undefined)
      .map(({ filename, patch }) => `--- ${filename}\n${patch}`)
      .join('\n\n')}`,
  ].join('\n\n');
};

export interface Decision {
  probabilities: Record<RiskLevel, number>;
  score: number;
  confidence: number;
  costUsd: number;
}

export type Decide = (input: string) => Promise<Decision>;

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const probabilitiesOf = (raw: unknown): Record<RiskLevel, number> => {
  const entries = Object.entries((raw ?? {}) as Record<string, unknown>);
  const byLevel = RISK_LEVELS.map((level, index) => {
    const found = entries.find(([key]) => key === level || key === String(index));
    return found?.[1];
  });
  if (!byLevel.every(isNumber)) {
    throw new Error('Jev answered without a probability for every level');
  }
  return Object.fromEntries(RISK_LEVELS.map((level, index) => [level, byLevel[index]])) as Record<
    RiskLevel,
    number
  >;
};

export const decisionsUrl = (baseUrl: URL): URL =>
  new URL('../alpha/decisions', `${baseUrl.href.replace(/\/$/, '')}/`);

export class GradingFailed extends Error {
  readonly category: GradingFailure;

  readonly detail: string;

  constructor(category: GradingFailure, message: string, detail = '') {
    super(message);
    this.name = 'GradingFailed';
    this.category = category;
    this.detail = detail;
  }
}

const MAX_DETAIL_LENGTH = 300;

const CONTEXT_EXCEEDED = /(maximum )?context[ _-]?(length|window)|too (large|long)/i;

const printable = (text: string): string =>
  text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ').trim().slice(0, MAX_DETAIL_LENGTH);

const detailOf = (error: { message?: unknown } | undefined): string =>
  typeof error?.message === 'string' ? printable(error.message) : '';

const isHttpError = (code: unknown): code is number =>
  Number.isInteger(code) && (code as number) >= 400 && (code as number) <= 599;

const failureOfResponse = (
  status: number,
  error: { message?: unknown; metadata?: { error_type?: unknown } } | undefined,
  model: string,
): GradingFailed => {
  const detail = detailOf(error);
  const exceeded =
    status === 413 ||
    ((status === 400 || status === 422) &&
      (error?.metadata?.error_type === 'context_length_exceeded' ||
        CONTEXT_EXCEEDED.test(String(error?.message ?? ''))));
  if (exceeded) {
    return new GradingFailed('too-large', "the input does not fit Jev's context window", detail);
  }
  if (status === 401) return new GradingFailed('setup', 'OpenRouter rejected the key', detail);
  if (status === 402) return new GradingFailed('setup', 'OpenRouter reports no credits', detail);
  if (status === 403) {
    return new GradingFailed('setup', "OpenRouter refused the key's access", detail);
  }
  if (status === 404) {
    return new GradingFailed('setup', `the model ${model} is not available on OpenRouter`, detail);
  }
  if (status === 408 || status === 429 || status >= 500) {
    return new GradingFailed('temporary', `OpenRouter answered ${status}`, detail);
  }
  return new GradingFailed('bug', `OpenRouter rejected the request with ${status}`, detail);
};

const failureOfTransport = (error: unknown): GradingFailed => {
  const name = error instanceof Error ? error.name : '';
  return name === 'TimeoutError' || name === 'AbortError'
    ? new GradingFailed('temporary', 'Jev timed out')
    : new GradingFailed(
        'temporary',
        'could not reach OpenRouter',
        printable(errorMessage(error)),
      );
};

export const jevDecides =
  (url: URL, apiKey: string, model: string, fetch: Fetch): Decide =>
  async (input) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        state: input,
        questions: {
          [QUESTION_NAME]: { type: 'score', criteria: CRITERIA, instructions: QUESTION },
        },
      }),
      signal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
    }).catch((error: unknown) => {
      throw failureOfTransport(error);
    });
    const body = (await response.json().catch((error: unknown) => {
      if (error instanceof SyntaxError) return response.ok ? undefined : {};
      throw failureOfTransport(error);
    })) as
      | {
          answers?: Record<
            string,
            { type?: string; score?: unknown; confidence?: unknown; probabilities?: unknown }
          >;
          usage?: { cost?: unknown };
          error?: { code?: unknown; message?: unknown; metadata?: { error_type?: unknown } } | null;
        }
      | undefined;
    if (!response.ok) {
      const error = typeof body === 'object' && body !== null ? body.error : undefined;
      throw failureOfResponse(response.status, error ?? undefined, model);
    }
    if (typeof body !== 'object' || body === null) {
      throw new GradingFailed('bug', 'OpenRouter answered with something that is not JSON');
    }
    if (body.error !== undefined && body.error !== null) {
      const code: unknown = body.error.code;
      if (isHttpError(code)) throw failureOfResponse(code, body.error, model);
      throw new GradingFailed('temporary', 'OpenRouter reported an error', detailOf(body.error));
    }
    const answer = body.answers?.[QUESTION_NAME];
    if (answer?.type === 'refusal') throw new GradingFailed('declined', 'Jev declined to answer');
    if (answer?.type !== 'score' || !isNumber(answer.score) || !isNumber(answer.confidence)) {
      throw new GradingFailed('bug', 'Jev answered with something other than a score');
    }
    let probabilities: Record<RiskLevel, number>;
    try {
      probabilities = probabilitiesOf(answer.probabilities);
    } catch (error) {
      throw new GradingFailed('bug', errorMessage(error));
    }
    return {
      probabilities,
      score: answer.score,
      confidence: answer.confidence,
      costUsd: isNumber(body.usage?.cost) ? body.usage.cost : 0,
    };
  };

export const levelsByProbability = (
  probabilities: Record<RiskLevel, number>,
): RiskLevel[] =>
  RISK_LEVELS.toSorted((a, b) => probabilities[b] - probabilities[a]);

const fixed = (value: number): string => value.toFixed(2);

export const checkRunOutput = (grade: RiskGrade): { title: string; summary: string } => {
  const [level, runnerUp] = levelsByProbability(grade.probabilities);
  const title = `Risk: ${grade.level}${grade.unsettled ? ' (unsettled)' : ''}, confidence ${fixed(grade.confidence)}`;
  return {
    title,
    summary: [
      `Most likely level: ${level}`,
      `Confidence: ${fixed(grade.confidence)}`,
      ...(grade.unsettled ? [`Runner-up: ${runnerUp}`] : []),
      '',
      'Probability per level:',
      ...RISK_LEVELS.map((name) => `- ${name}: ${fixed(grade.probabilities[name])}`),
      '',
      `Model: ${grade.model}`,
    ].join('\n'),
  };
};

export const decideGrade = (
  decision: Decision,
  due: GradingDue,
  model: string,
  threshold: number,
  gradedAt: string,
): RiskGrade => ({
  repository: due.repository,
  number: due.number,
  headSha: due.headSha,
  fingerprint: gradingFingerprint(model),
  model,
  probabilities: decision.probabilities,
  score: decision.score,
  confidence: decision.confidence,
  level: levelsByProbability(decision.probabilities)[0] as RiskLevel,
  unsettled: decision.confidence < threshold,
  costUsd: decision.costUsd,
  gradedAt,
});

export interface GradePullRequestsOptions {
  store: Store;
  fetch: Fetch;
  tokens: InstallationTokens;
  decide: Decide;
  repositories: Record<string, string>;
  model: string;
  threshold: number;
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

const changedFiles = async (
  fetch: Fetch,
  token: string,
  repository: string,
  number: number,
): Promise<ChangedFile[]> => {
  const files: ChangedFile[] = [];
  for (let page = 1; page <= MAX_FILES_PAGES; page += 1) {
    const batch = (await github(
      fetch,
      token,
      `/repos/${repository}/pulls/${number}/files?per_page=${FILES_PAGE_SIZE}&page=${page}`,
    )) as ChangedFile[];
    files.push(...batch);
    if (batch.length < FILES_PAGE_SIZE) break;
  }
  return files;
};

const gradeOne = async (
  options: GradePullRequestsOptions,
  due: GradingDue,
  repository: string,
): Promise<void> => {
  const { store, fetch, tokens, decide, model, threshold, now } = options;
  const token = await tokens(repository, 'grading');
  const pull = (await github(fetch, token, `/repos/${repository}/pulls/${due.number}`)) as {
    state: string;
    draft: boolean;
    head: { sha: string };
  };
  if (pull.state !== 'open' || pull.draft || pull.head.sha !== due.headSha) return;
  const [closed] = due.closes;
  if (closed === undefined) {
    options.log(`${due.repository}#${due.number}: closes no ticket, so there is nothing to grade it against`);
    return;
  }
  const { ticket, spec } = await queryTicketContext(fetch, token, repository, closed);
  const files = await changedFiles(fetch, token, repository, due.number);
  let decision: Decision;
  try {
    decision = await decide(gradingInput(ticket, spec, files));
  } catch (error) {
    if (!(error instanceof GradingFailed)) throw error;
    const failed: GradingAttempt = {
      repository: due.repository,
      number: due.number,
      headSha: due.headSha,
      attemptedAt: now(),
      category: error.category,
      message: error.message,
    };
    store.recordGradingAttempt(failed);
    options.log(
      `${due.repository}#${due.number}: not graded (${failed.category}): ${failed.message}${error.detail === '' ? '' : ` (${error.detail})`}`,
    );
    await postAttemptCheck(options, failed, repository);
    return;
  }
  const grade = decideGrade(decision, due, model, threshold, now());
  store.recordRiskGrade(grade);
  await postCheck(options, grade, repository);
  await applyLabels(options, grade, repository);
};

const setRiskLabels = async (
  { fetch, tokens }: GradePullRequestsOptions,
  grade: RiskGrade,
  repository: string,
  wanted: readonly string[],
): Promise<void> => {
  const token = await tokens(repository, 'grading');
  const path = `/repos/${repository}/issues/${grade.number}/labels`;
  const present = ((await github(fetch, token, `${path}?per_page=100`)) as { name: string }[]).map(
    ({ name }) => name,
  );
  for (const name of present.filter(
    (name) => name.startsWith(RISK_LABEL_PREFIX) && !wanted.includes(name),
  )) {
    await github(fetch, token, `${path}/${encodeURIComponent(name)}`, { method: 'DELETE' });
  }
  const missing = wanted.filter((name) => !present.includes(name));
  if (missing.length > 0) {
    await github(fetch, token, path, { method: 'POST', body: { labels: missing } });
  }
};

const applyLabels = async (
  options: GradePullRequestsOptions,
  grade: RiskGrade,
  repository: string,
): Promise<void> => {
  await setRiskLabels(options, grade, repository, riskLabels(grade));
  options.store.markLabelsApplied(grade, true);
};

const removeLabels = async (
  options: GradePullRequestsOptions,
  grade: RiskGrade,
  repository: string,
): Promise<void> => {
  await setRiskLabels(options, grade, repository, []);
  options.store.markLabelsApplied(grade, false);
};

const postCheckRun = async (
  { fetch, tokens }: GradePullRequestsOptions,
  repository: string,
  headSha: string,
  output: { title: string; summary: string },
): Promise<void> => {
  await github(fetch, await tokens(repository, 'grading'), `/repos/${repository}/check-runs`, {
    method: 'POST',
    body: {
      name: CHECK_NAME,
      head_sha: headSha,
      status: 'completed',
      conclusion: 'neutral',
      output,
    },
  });
};

const postCheck = async (
  options: GradePullRequestsOptions,
  grade: RiskGrade,
  repository: string,
): Promise<void> => {
  await postCheckRun(options, repository, grade.headSha, checkRunOutput(grade));
  options.store.markCheckPosted(grade);
};

export const attemptCheckOutput = (
  attempt: Pick<GradingAttempt, 'category' | 'message'>,
): { title: string; summary: string } => {
  const retried = RETRIED_GRADING_FAILURES.includes(attempt.category);
  return {
    title: notGradedTitle(attempt),
    summary: [
      `This head commit has no risk grade: ${attempt.message}.`,
      '',
      retried
        ? 'Forge keeps asking Jev, further apart each time, until it answers.'
        : 'Forge does not ask Jev about this head commit again.',
    ].join('\n'),
  };
};

const postAttemptCheck = async (
  options: GradePullRequestsOptions,
  attempt: GradingAttempt,
  repository: string,
): Promise<void> => {
  await postCheckRun(options, repository, attempt.headSha, attemptCheckOutput(attempt));
  options.store.markAttemptCheckPosted(attempt);
};

const attempt = async (
  options: GradePullRequestsOptions,
  what: string,
  subject: { repository: string; number: number },
  work: () => Promise<void>,
): Promise<boolean> => {
  try {
    await work();
    return true;
  } catch (error) {
    options.log(`${subject.repository}#${subject.number}: could not ${what}: ${errorMessage(error)}`);
    return false;
  }
};

export const gradePullRequests = async (options: GradePullRequestsOptions): Promise<boolean> => {
  const { store, repositories } = options;
  const names = Object.keys(repositories);
  const repositoryOf = (grade: { repository: string }): string => repositories[grade.repository] as string;
  const outcomes: boolean[] = [];
  for (const grade of store.gradesWithStaleLabels(names)) {
    outcomes.push(
      await attempt(options, 'take the stale risk labels off', grade, () =>
        removeLabels(options, grade, repositoryOf(grade)),
      ),
    );
  }
  for (const grade of store.gradesAwaitingDisplay(names)) {
    if (!grade.checkPosted) {
      outcomes.push(
        await attempt(options, 'post the check run', grade, () =>
          postCheck(options, grade, repositoryOf(grade)),
        ),
      );
    }
    if (!grade.labelsApplied) {
      outcomes.push(
        await attempt(options, 'apply the risk labels', grade, () =>
          applyLabels(options, grade, repositoryOf(grade)),
        ),
      );
    }
  }
  for (const failed of store.attemptsAwaitingCheck(names)) {
    outcomes.push(
      await attempt(options, 'post the check run', failed, () =>
        postAttemptCheck(options, failed, repositoryOf(failed)),
      ),
    );
  }
  for (const due of store.gradingDue(names, options.now())) {
    outcomes.push(
      await attempt(options, 'grade', due, () => gradeOne(options, due, repositoryOf(due))),
    );
  }
  return outcomes.every(Boolean);
};
