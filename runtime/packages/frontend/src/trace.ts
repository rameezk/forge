import type { GenerationKind, GenerationRecord, HarnessEvent, TokenUsage } from '@forge/shared';

export const isCall = ({ generationId, usage }: GenerationRecord): boolean =>
  generationId !== null || usage !== null;

export const promptTokens = (usage: TokenUsage): number =>
  usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;

const CACHE_MISS_BELOW = 0.5;

const cacheMisses = (calls: GenerationRecord[]): ReadonlySet<GenerationRecord> => {
  const previousPrompt = new Map<string | null, number>();
  const misses = new Set<GenerationRecord>();
  for (const call of calls) {
    const { usage } = call;
    if (usage === null) continue;
    const previous = previousPrompt.get(call.subagent);
    if (previous !== undefined && usage.cacheReadTokens < previous * CACHE_MISS_BELOW) {
      misses.add(call);
    }
    previousPrompt.set(call.subagent, promptTokens(usage));
  }
  return misses;
};

export type CostBasis = 'billed' | 'estimated' | 'pending' | 'list-price' | 'subscription';

export interface StepCost {
  usd: number;
  basis: CostBasis;
}

export type StepKind = 'generation' | 'tool' | 'subagent' | 'compaction' | 'cache_warm';

export interface Step {
  kind: StepKind;
  name: string;
  cost: StepCost | null;
  usd: number;
  cacheMiss: boolean;
  retries: number;
  generation: GenerationRecord | null;
  children: Step[];
}

export interface Trace {
  steps: Step[];
  total: number;
  maxUsd: number;
  calls: number;
  misses: number;
  usage: TokenUsage;
  timed: boolean;
}

const costOf = (
  { billedCostUsd, estimatedCostUsd, listPriceEquivalentUsd }: GenerationRecord,
  subscription: boolean,
): StepCost => {
  if (subscription) {
    return listPriceEquivalentUsd === null
      ? { usd: 0, basis: 'subscription' }
      : { usd: listPriceEquivalentUsd, basis: 'list-price' };
  }
  if (billedCostUsd !== null) return { usd: billedCostUsd, basis: 'billed' };
  if (estimatedCostUsd !== null) return { usd: estimatedCostUsd, basis: 'estimated' };
  return { usd: 0, basis: 'pending' };
};

const STEP_KINDS: Record<GenerationKind, StepKind> = {
  message: 'generation',
  compaction: 'compaction',
  cache_warm: 'cache_warm',
};

const hasArrival = (event: HarnessEvent): boolean => 'at' in event;

const spent = (step: Step): number =>
  (step.kind === 'subagent' ? 0 : (step.cost?.usd ?? 0)) + step.children.reduce((sum, child) => sum + spent(child), 0);

const flatten = (steps: Step[]): Step[] => steps.flatMap((step) => [step, ...flatten(step.children)]);

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

export const traceOf = (
  events: HarnessEvent[],
  generations: GenerationRecord[],
  subscription: boolean,
): Trace => {
  const calls = generations.filter(isCall);
  const misses = cacheMisses(calls);
  const byId = new Map(calls.flatMap((call) => (call.generationId === null ? [] : [[call.generationId, call] as const])));
  const joined = new Set<GenerationRecord>();
  const scopes = new Set(events.flatMap((event) => (event.type !== 'result' && event.subagent !== undefined ? [event.subagent] : [])));

  const steps: Step[] = [];
  const branches = new Map<string, Step>();
  const lastGeneration = new Map<string | null, Step>();
  const pendingRetries = new Map<string | null, number>();

  const containerOf = (scope: string | null): Step[] =>
    scope === null ? steps : branchOf(scope).children;

  const branchOf = (scope: string): Step => {
    const known = branches.get(scope);
    if (known !== undefined) return known;
    const branch = newStep('subagent', scope);
    branches.set(scope, branch);
    steps.push(branch);
    return branch;
  };

  const place = (record: GenerationRecord, scope: string | null): void => {
    joined.add(record);
    const cost = costOf(record, subscription);
    const step: Step = {
      ...newStep(STEP_KINDS[record.kind], record.servedModel ?? ''),
      cost,
      usd: cost.usd,
      cacheMiss: misses.has(record),
      retries: pendingRetries.get(scope) ?? 0,
      generation: record,
    };
    pendingRetries.delete(scope);
    containerOf(scope).push(step);
    if (step.kind === 'generation') lastGeneration.set(scope, step);
  };

  for (const event of events) {
    if (event.type === 'result') continue;
    const scope = event.subagent ?? null;
    switch (event.type) {
      case 'message': {
        const record = event.role === 'assistant' && event.generationId !== null ? byId.get(event.generationId) : undefined;
        if (record !== undefined && !joined.has(record)) place(record, scope);
        break;
      }
      case 'tool_call': {
        const isBranch = scopes.has(event.id);
        if (isBranch && branches.has(event.id)) break;
        const step = newStep(isBranch ? 'subagent' : 'tool', event.name);
        if (isBranch) branches.set(event.id, step);
        (lastGeneration.get(scope)?.children ?? containerOf(scope)).push(step);
        break;
      }
      case 'retry':
        pendingRetries.set(scope, (pendingRetries.get(scope) ?? 0) + 1);
        break;
      case 'compaction':
        for (const { generationId } of event.calls ?? []) {
          const record = generationId === null ? undefined : byId.get(generationId);
          if (record !== undefined && !joined.has(record)) place(record, scope);
        }
        break;
      case 'cache_warm': {
        const record = event.generationId === null ? undefined : byId.get(event.generationId);
        if (record !== undefined && !joined.has(record)) place(record, scope);
        break;
      }
      case 'tool_result':
        break;
    }
  }

  for (const [scope, retries] of pendingRetries) {
    const last = lastGeneration.get(scope);
    if (last !== undefined) last.retries += retries;
  }
  pendingRetries.clear();

  for (const record of calls) {
    if (!joined.has(record)) place(record, record.subagent);
  }

  const settle = (step: Step): void => {
    step.children.forEach(settle);
    if (step.kind === 'subagent') step.usd = sum(step.children.map(spent));
  };
  steps.forEach(settle);

  const measured = calls.flatMap(({ usage }) => (usage === null ? [] : [usage]));
  return {
    steps,
    total: sum(steps.map(spent)),
    maxUsd: Math.max(0, ...flatten(steps).map(({ usd }) => usd)),
    calls: calls.length,
    misses: misses.size,
    usage: {
      inputTokens: sum(measured.map(({ inputTokens }) => inputTokens)),
      outputTokens: sum(measured.map(({ outputTokens }) => outputTokens)),
      cacheReadTokens: sum(measured.map(({ cacheReadTokens }) => cacheReadTokens)),
      cacheWriteTokens: sum(measured.map(({ cacheWriteTokens }) => cacheWriteTokens)),
    },
    timed: events.some(hasArrival),
  };
};

const newStep = (kind: StepKind, name: string): Step => ({
  kind,
  name,
  cost: null,
  usd: 0,
  cacheMiss: false,
  retries: 0,
  generation: null,
  children: [],
});
