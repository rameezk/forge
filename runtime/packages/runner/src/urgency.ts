import {
  errorMessage,
  queryTicketContext,
  URGENCY_LEVELS,
  type ContextIssue,
  type DisplayedUrgencyGrade,
  type Fetch,
  type InstallationTokens,
  type Store,
  type UrgencyDue,
  type UrgencyGrade,
  type UrgencyLevel,
} from '@forge/shared';
import {
  fingerprintOf,
  GradingFailed,
  levelsByProbability,
  setLabels,
  type Decide,
  type Decision,
  type Question,
} from './grading.ts';

export const URGENCY_LABEL_PREFIX = 'forge:urgency-';

export const URGENCY_UNCERTAIN_LABEL = `${URGENCY_LABEL_PREFIX}uncertain`;

export const urgencyLabels = (grade: Pick<UrgencyGrade, 'level' | 'uncertain'>): string[] => [
  `${URGENCY_LABEL_PREFIX}${grade.level}`,
  ...(grade.uncertain ? [URGENCY_UNCERTAIN_LABEL] : []),
];

export const URGENCY_QUESTION_NAME = 'urgency';

export const URGENCY_INSTRUCTIONS =
  'How soon should this ticket be built, judged by what is hurt and who is blocked while it waits? Judge by the ticket and its parent spec, and by what the repository is and who depends on it.';

export const URGENCY_DESCRIPTIONS: Record<UrgencyLevel, string> = {
  critical: 'something live is broken or losing data now',
  high: 'a defect users can hit, or work blocking other people',
  normal: 'planned feature or improvement work',
  low: 'cleanup, docs or nice-to-have work',
};

export const URGENCY_QUESTION: Question = {
  name: URGENCY_QUESTION_NAME,
  instructions: URGENCY_INSTRUCTIONS,
  levels: URGENCY_LEVELS,
  descriptions: URGENCY_DESCRIPTIONS,
};

export const urgencyInput = (
  ticket: ContextIssue,
  spec: ContextIssue | null,
  description: string | null,
): string => {
  const issue = (label: string, { number, title, body, comments }: ContextIssue): string =>
    [
      `# ${label} #${number}: ${title}\n\n${body}`,
      ...comments.map(({ author, body: text }) => `## Comment by ${author}\n\n${text}`),
    ].join('\n\n');
  return [
    ...(description === null ? [] : [`# Repository\n\n${description}`]),
    issue('Ticket', ticket),
    ...(spec === null ? [] : [issue('Parent spec', spec)]),
  ].join('\n\n');
};

export const decideUrgency = (
  decision: Decision,
  due: UrgencyDue,
  model: string,
  threshold: number,
  gradedAt: string,
): UrgencyGrade => ({
  repository: due.repository,
  number: due.number,
  version: due.version,
  fingerprint: fingerprintOf(URGENCY_QUESTION, model),
  model,
  probabilities: decision.probabilities as Record<UrgencyLevel, number>,
  score: decision.score,
  confidence: decision.confidence,
  level: levelsByProbability(decision.probabilities, URGENCY_LEVELS)[0] as UrgencyLevel,
  uncertain: decision.confidence < threshold,
  costUsd: decision.costUsd,
  gradedAt,
});

export interface UrgencyRepository {
  github: string;
  description: string | null;
}

export interface GradeUrgencyOptions {
  store: Store;
  fetch: Fetch;
  tokens: InstallationTokens;
  decide: Decide;
  repositories: Record<string, UrgencyRepository>;
  model: string;
  threshold: number;
  now: () => string;
  log: (line: string) => void;
}

const applyLabels = async (
  { store, fetch, tokens, repositories }: GradeUrgencyOptions,
  grade: DisplayedUrgencyGrade,
): Promise<void> => {
  const { github } = repositories[grade.repository] as UrgencyRepository;
  await setLabels(
    fetch,
    await tokens(github, 'write'),
    github,
    grade.number,
    URGENCY_LABEL_PREFIX,
    urgencyLabels(grade),
  );
  store.markUrgencyLabelsApplied(grade);
};

const gradeOne = async (options: GradeUrgencyOptions, due: UrgencyDue): Promise<void> => {
  const { store, fetch, tokens, decide, model, threshold, now, repositories } = options;
  const { github, description } = repositories[due.repository] as UrgencyRepository;
  const { ticket, spec } = await queryTicketContext(
    fetch,
    await tokens(github, 'grading'),
    github,
    due.number,
  );
  let decision: Decision;
  try {
    decision = await decide(urgencyInput(ticket, spec, description));
  } catch (error) {
    if (!(error instanceof GradingFailed)) throw error;
    store.recordUrgencyAttempt({
      repository: due.repository,
      number: due.number,
      version: due.version,
      attemptedAt: now(),
      category: error.category,
      message: error.message,
    });
    options.log(
      `${due.repository}#${due.number}: urgency not graded (${error.category}): ${error.message}${error.detail === '' ? '' : ` (${error.detail})`}`,
    );
    return;
  }
  const grade = decideUrgency(decision, due, model, threshold, now());
  store.recordUrgencyGrade(grade);
  await applyLabels(options, { ...grade, labelsApplied: false });
};

const attempt = async (
  options: GradeUrgencyOptions,
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

export const gradeUrgency = async (options: GradeUrgencyOptions): Promise<boolean> => {
  const { store, repositories } = options;
  const names = Object.keys(repositories);
  const outcomes: boolean[] = [];
  for (const grade of store.urgencyGradesAwaitingLabels(names)) {
    outcomes.push(
      await attempt(options, 'apply the urgency labels', grade, () => applyLabels(options, grade)),
    );
  }
  for (const due of store.urgencyDue(names, options.now())) {
    outcomes.push(await attempt(options, 'grade the urgency', due, () => gradeOne(options, due)));
  }
  return outcomes.every(Boolean);
};
