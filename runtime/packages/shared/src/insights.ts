import type { ConfigFingerprint } from './fingerprint.ts';
import type { PullRequestState } from './dispatch.ts';
import { DIAGNOSIS_CATEGORIES, type DiagnosisCategory } from './diagnosis.ts';

export type InsightKind = 'dispatch' | 'revision' | 'conflict-resolution';

export type InsightKindFilter = InsightKind | 'all';

export const INSIGHT_KIND_FILTERS: readonly InsightKindFilter[] = ['dispatch', 'revision', 'conflict-resolution', 'all'];

export type InsightOutcome = 'running' | 'done' | 'failed';

export interface InsightsFilter {
  kind: InsightKindFilter;
  includeManual: boolean;
  worker?: string;
  repository?: string;
  startedFrom?: string;
  startedBefore?: string;
}

export interface InsightWorkload {
  worker: string;
  repository: string | null;
  fingerprintHash: string | null;
  fingerprint: ConfigFingerprint | null;
  kind: InsightKind | null;
  outcome: InsightOutcome | null;
  listPrice: boolean;
  costUsd: number | null;
  durationMs: number;
  inputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  toolCalls: number | null;
  retries: number | null;
  pullRequest: { state: PullRequestState; rework: number | null } | null;
  diagnosis: DiagnosisCategory | null;
}

export interface CohortFailures {
  failed: number;
  diagnosed: number;
  categories: Record<DiagnosisCategory, number>;
}

export interface ActivePair {
  worker: string;
  repository: string;
}

export interface RanPair {
  worker: string;
  repository: string | null;
}

export interface CohortActivity {
  hash: string | null;
  firstRun: string;
  lastRun: string;
  activeFor: ActivePair[];
}

export interface CohortInsight {
  hash: string | null;
  firstRun: string | null;
  lastRun: string | null;
  activeFor: ActivePair[];
  ranFor: RanPair[];
  fingerprint: ConfigFingerprint | null;
  workloads: number;
  listPrice: boolean;
  doneRate: number | null;
  openedRate: number | null;
  mergedRate: number | null;
  costMedian: number | null;
  costP90: number | null;
  costPerMerged: number | null;
  durationMedianMs: number;
  cacheHitRate: number | null;
  toolCallsMedian: number | null;
  retriesPerWorkload: number | null;
  reworkPerMerged: number | null;
  failures: CohortFailures;
}

export type WorkloadOutcome = 'merged' | 'opened' | 'failed';

export interface InsightPoint {
  runId: string;
  fingerprintHash: string | null;
  startTime: string;
  costUsd: number;
  listPrice: boolean;
  outcome: WorkloadOutcome | null;
}

export interface ProviderShare {
  hash: string | null;
  providers: { provider: string; tokens: number }[];
}

export interface InsightsOptions {
  workers: string[];
  repositories: string[];
}

export const outcomeOf = (
  dispatched: boolean,
  pullRequest: { state: PullRequestState } | null,
): WorkloadOutcome | null => {
  if (!dispatched) return null;
  if (pullRequest === null) return 'failed';
  return pullRequest.state === 'merged' ? 'merged' : 'opened';
};

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

const present = <T>(values: (T | null)[]): T[] => values.filter((value): value is T => value !== null);

export const quantile = (values: number[], fraction: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
};

const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

const cacheHitRate = (workloads: InsightWorkload[]): number | null => {
  let read = 0;
  let prompt = 0;
  for (const { inputTokens, cacheReadTokens, cacheWriteTokens } of workloads) {
    if (cacheReadTokens === null || cacheWriteTokens === null) continue;
    read += cacheReadTokens;
    prompt += inputTokens + cacheReadTokens + cacheWriteTokens;
  }
  return ratio(read, prompt);
};

const ranFor = (members: InsightWorkload[]): RanPair[] => {
  const pairs = new Map<string, RanPair>();
  for (const { worker, repository } of members) pairs.set(JSON.stringify([worker, repository]), { worker, repository });
  return [...pairs.values()].sort(
    (a, b) => a.worker.localeCompare(b.worker) || (a.repository ?? '').localeCompare(b.repository ?? ''),
  );
};

const noCategories = (): Record<DiagnosisCategory, number> =>
  Object.fromEntries(DIAGNOSIS_CATEGORIES.map((category) => [category, 0])) as Record<DiagnosisCategory, number>;

export const sumFailures = (all: CohortFailures[]): CohortFailures => {
  const total = noFailures();
  for (const { failed, diagnosed, categories } of all) {
    total.failed += failed;
    total.diagnosed += diagnosed;
    for (const category of DIAGNOSIS_CATEGORIES) total.categories[category] += categories[category];
  }
  return total;
};

export const noFailures = (): CohortFailures => ({ failed: 0, diagnosed: 0, categories: noCategories() });

const failuresOf = (members: InsightWorkload[]): CohortFailures => {
  const failures = noFailures();
  for (const { outcome, diagnosis } of members) {
    if (outcome !== 'failed') continue;
    failures.failed += 1;
    if (diagnosis === null) continue;
    failures.diagnosed += 1;
    failures.categories[diagnosis] += 1;
  }
  return failures;
};

const summarize = (members: InsightWorkload[], activity: CohortActivity | undefined): CohortInsight => {
  const dispatched = members.filter(({ kind }) => kind === 'dispatch');
  const settled = members.filter(({ outcome }) => outcome !== null);
  const merged = dispatched.filter(({ pullRequest }) => pullRequest?.state === 'merged');
  const toolCalls = present(members.map(({ toolCalls: count }) => count));
  const retries = present(members.map(({ retries: count }) => count));
  const rework = present(merged.map(({ pullRequest }) => pullRequest?.rework ?? null));
  const billed = members.filter(({ listPrice }) => !listPrice);
  const basis = billed.length === 0 ? members : billed;
  const costs = present(basis.map(({ costUsd }) => costUsd));
  const dispatchedCosts = basis.filter(({ kind }) => kind === 'dispatch').map(({ costUsd }) => costUsd);
  const unpriced = dispatchedCosts.some((cost) => cost === null);
  return {
    hash: members[0]!.fingerprintHash,
    firstRun: activity?.firstRun ?? null,
    lastRun: activity?.lastRun ?? null,
    activeFor: activity?.activeFor ?? [],
    ranFor: ranFor(members),
    fingerprint: members[0]!.fingerprint,
    workloads: members.length,
    listPrice: billed.length === 0,
    doneRate: ratio(settled.filter(({ outcome }) => outcome === 'done').length, settled.length),
    openedRate: ratio(dispatched.filter(({ pullRequest }) => pullRequest !== null).length, dispatched.length),
    mergedRate: ratio(merged.length, dispatched.length),
    costMedian: costs.length === 0 ? null : quantile(costs, 0.5),
    costP90: costs.length === 0 ? null : quantile(costs, 0.9),
    costPerMerged: unpriced ? null : ratio(sum(present(dispatchedCosts)), merged.length),
    durationMedianMs: quantile(members.map(({ durationMs }) => durationMs), 0.5),
    cacheHitRate: cacheHitRate(members),
    toolCallsMedian: toolCalls.length === 0 ? null : quantile(toolCalls, 0.5),
    retriesPerWorkload: ratio(sum(retries), retries.length),
    reworkPerMerged: ratio(sum(rework), rework.length),
    failures: failuresOf(members),
  };
};

export const aggregateCohorts = (workloads: InsightWorkload[], activity: CohortActivity[]): CohortInsight[] => {
  const groups = new Map<string | null, InsightWorkload[]>();
  for (const workload of workloads) {
    const members = groups.get(workload.fingerprintHash) ?? [];
    members.push(workload);
    groups.set(workload.fingerprintHash, members);
  }
  const activityOf = new Map(activity.map((entry) => [entry.hash, entry]));
  return [...groups.entries()]
    .map(([hash, members]) => summarize(members, activityOf.get(hash)))
    .sort(
      (a, b) =>
        Number(a.hash === null) - Number(b.hash === null) ||
        Number(b.activeFor.length > 0) - Number(a.activeFor.length > 0) ||
        (b.lastRun ?? '').localeCompare(a.lastRun ?? '') ||
        (a.hash ?? '').localeCompare(b.hash ?? ''),
    );
};
