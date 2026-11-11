import type { ConflictResolutionFailure } from './conflict-resolution.ts';
import type { DispatchFailure } from './dispatch.ts';
import type { RevisionFailure } from './revision.ts';

export const DIAGNOSIS_CATEGORIES = [
  'worker',
  'skill',
  'ticket-or-spec',
  'repository-environment',
  'forge',
  'provider-and-infra',
  'unclear',
] as const;

export type DiagnosisCategory = (typeof DIAGNOSIS_CATEGORIES)[number];

export const DIAGNOSIS_CATEGORY_LABELS: Record<DiagnosisCategory, string> = {
  worker: 'Worker',
  skill: 'Skill',
  'ticket-or-spec': 'Ticket or spec',
  'repository-environment': 'Repository environment',
  forge: 'Forge',
  'provider-and-infra': 'Provider and infra',
  unclear: 'Unclear',
};

export const isDiagnosisCategory = (value: unknown): value is DiagnosisCategory =>
  typeof value === 'string' && (DIAGNOSIS_CATEGORIES as readonly string[]).includes(value);

export const DIAGNOSIS_FILE = 'diagnosis.json';

export interface DiagnosisEvidence {
  turn: number;
  note: string;
}

export interface DiagnosisVerdict {
  category: DiagnosisCategory;
  evidence: DiagnosisEvidence[];
  suggestedFix: string;
}

export type DiagnosisState = 'running' | 'done' | 'failed';

export interface DiagnosisRecord {
  id: number;
  runId: string;
  failedRunId: string;
  state: DiagnosisState;
  verdict: DiagnosisVerdict | null;
  detail: string | null;
  startedAt: string;
  endedAt: string | null;
}

export const DIAGNOSED_FAILURES = [
  'errored',
  'no-pull-request',
  'draft',
  'check-failed',
  'check-pending',
  'exceeded',
  'unanswered',
  'not-merged',
  'still-conflicting',
] as const;

export const UNDIAGNOSED_FAILURES = [
  'interrupted',
  'crashed',
  'devshell-failed',
  'skill-not-found',
  'not-started',
] as const;

type WorkloadFailure = DispatchFailure | RevisionFailure | ConflictResolutionFailure;

type Unplaced = Exclude<WorkloadFailure, (typeof DIAGNOSED_FAILURES)[number] | (typeof UNDIAGNOSED_FAILURES)[number]>;

const everyFailureIsPlaced: [Unplaced] extends [never] ? true : never = true;
void everyFailureIsPlaced;

export const isDiagnosedFailure = (reason: string | null): boolean =>
  reason !== null && (DIAGNOSED_FAILURES as readonly string[]).includes(reason);

const TEXT_LIMIT = 4000;

export const MAX_EVIDENCE = 20;

export const MAX_VERDICT_BYTES = 65_536;

const textOf = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.slice(0, TEXT_LIMIT) : null;

export const parseVerdict = (contents: string): DiagnosisVerdict => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`${DIAGNOSIS_FILE} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${DIAGNOSIS_FILE} must hold a JSON object`);
  }
  const { category, evidence, suggestedFix } = parsed as Record<string, unknown>;
  if (!isDiagnosisCategory(category)) {
    throw new Error(`${DIAGNOSIS_FILE} category must be one of ${DIAGNOSIS_CATEGORIES.join(', ')}`);
  }
  if (!Array.isArray(evidence) || evidence.length === 0) {
    throw new Error(`${DIAGNOSIS_FILE} evidence must list at least one entry`);
  }
  if (evidence.length > MAX_EVIDENCE) {
    throw new Error(`${DIAGNOSIS_FILE} evidence must list at most ${MAX_EVIDENCE} entries`);
  }
  const entries = evidence.map((entry: unknown, index): DiagnosisEvidence => {
    const { turn, note } = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const text = textOf(note);
    if (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 1 || text === null) {
      throw new Error(`${DIAGNOSIS_FILE} evidence entry ${index + 1} must hold a positive integer turn and a note`);
    }
    return { turn, note: text };
  });
  const fix = textOf(suggestedFix);
  if (fix === null) {
    throw new Error(`${DIAGNOSIS_FILE} suggestedFix must be a non-empty string`);
  }
  return { category, evidence: entries, suggestedFix: fix };
};
