import type { ConfigFingerprint } from './fingerprint.ts';
import type { PullRequestState } from './dispatch.ts';

export interface InsightsFilter {
  includeManual: boolean;
  worker?: string;
  repository?: string;
  startedFrom?: string;
  startedBefore?: string;
}

export interface InsightWorkload {
  fingerprintHash: string | null;
  fingerprint: ConfigFingerprint | null;
  dispatched: boolean;
  listPrice: boolean;
  costUsd: number | null;
  durationMs: number;
  inputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  toolCalls: number | null;
  retries: number | null;
  pullRequest: { state: PullRequestState; rework: number | null } | null;
}

export interface ActivePair {
  worker: string;
  repository: string;
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
  fingerprint: ConfigFingerprint | null;
  workloads: number;
  listPrice: boolean;
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

const summarize = (members: InsightWorkload[], activity: CohortActivity | undefined): CohortInsight => {
  const dispatched = members.filter(({ dispatched: isDispatched }) => isDispatched);
  const merged = dispatched.filter(({ pullRequest }) => pullRequest?.state === 'merged');
  const toolCalls = present(members.map(({ toolCalls: count }) => count));
  const retries = present(members.map(({ retries: count }) => count));
  const rework = present(merged.map(({ pullRequest }) => pullRequest?.rework ?? null));
  const billed = members.filter(({ listPrice }) => !listPrice);
  const basis = billed.length === 0 ? members : billed;
  const costs = present(basis.map(({ costUsd }) => costUsd));
  const dispatchedCosts = basis.filter(({ dispatched: isDispatched }) => isDispatched).map(({ costUsd }) => costUsd);
  const unpriced = dispatchedCosts.some((cost) => cost === null);
  return {
    hash: members[0]!.fingerprintHash,
    firstRun: activity?.firstRun ?? null,
    lastRun: activity?.lastRun ?? null,
    activeFor: activity?.activeFor ?? [],
    fingerprint: members[0]!.fingerprint,
    workloads: members.length,
    listPrice: billed.length === 0,
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
