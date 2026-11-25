import type { GenerationKind, GenerationRecord, HarnessEvent, TokenUsage } from '@forge/shared';
import { eventAnchors } from './views/transcript.ts';

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
  start: number | null;
  end: number | null;
  generation: GenerationRecord | null;
  id: string | null;
  anchor: number | null;
  request: string | null;
  response: string | null;
  failed: boolean;
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
  start: number | null;
  end: number | null;
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

const arrivalOf = ({ at }: HarnessEvent): number | null => {
  if (at === undefined) return null;
  const time = Date.parse(at);
  return Number.isNaN(time) ? null : time;
};

const earliestOf = (times: (number | null)[]): number | null => {
  let earliest: number | null = null;
  for (const time of times) {
    if (time !== null && (earliest === null || time < earliest)) earliest = time;
  }
  return earliest;
};

const EXCERPT_CHARS = 600;

const excerpt = (text: string | null | undefined): string | null => {
  const trimmed = text?.trim() ?? '';
  if (trimmed === '') return null;
  return trimmed.length > EXCERPT_CHARS ? `${trimmed.slice(0, EXCERPT_CHARS)}…` : trimmed;
};

const commandOf = (args: unknown): string | null => {
  if (typeof args === 'string') return excerpt(args);
  if (typeof args !== 'object' || args === null) return null;
  const fields = args as Record<string, unknown>;
  const given = [fields['command'], fields['task'], fields['prompt']].find((value): value is string => typeof value === 'string');
  if (given !== undefined) return excerpt(given);
  return Object.keys(fields).length === 0 ? null : excerpt(JSON.stringify(fields, null, 2));
};

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
  const anchorOf = eventAnchors(events);
  const lastInput = new Map<string | null, string>();
  const unanswered = new Map<string, Step>();
  const scopes = new Set(events.flatMap((event) => (event.type !== 'result' && event.subagent !== undefined ? [event.subagent] : [])));

  const steps: Step[] = [];
  const branches = new Map<string, Step>();
  const lastGeneration = new Map<string | null, Step>();
  const asked = new Map<string, Step>();
  const pendingRetries = new Map<string | null, number>();

  const containerOf = (scope: string | null): Step[] =>
    scope === null ? steps : branchOf(scope).children;

  const branchOf = (scope: string): Step => {
    const known = branches.get(scope);
    if (known !== undefined) return known;
    const branch = { ...newStep('subagent', scope), id: scope };
    branches.set(scope, branch);
    steps.push(branch);
    return branch;
  };

  const place = (
    record: GenerationRecord,
    scope: string | null,
    start: number | null,
    end: number | null,
    source?: HarnessEvent,
    response?: string | null,
  ): void => {
    joined.add(record);
    const cost = costOf(record, subscription);
    const step: Step = {
      ...newStep(STEP_KINDS[record.kind], record.servedModel ?? ''),
      cost,
      usd: cost.usd,
      cacheMiss: misses.has(record),
      retries: pendingRetries.get(scope) ?? 0,
      start: end === null ? null : start,
      end,
      generation: record,
      anchor: source === undefined ? null : anchorOf(source),
      request: source === undefined ? null : excerpt(lastInput.get(scope)),
      response: excerpt(response),
    };
    pendingRetries.delete(scope);
    containerOf(scope).push(step);
    if (step.kind === 'generation') lastGeneration.set(scope, step);
  };

  let previous: number | null = null;
  let first: number | null = null;
  let last: number | null = null;

  for (const event of events) {
    const arrived = arrivalOf(event);
    const before = previous;
    if (arrived !== null) {
      previous = arrived;
      first ??= arrived;
      last = arrived;
    }
    if (event.type === 'result') continue;
    const scope = event.subagent ?? null;
    switch (event.type) {
      case 'message': {
        const record = event.role === 'assistant' && event.generationId !== null ? byId.get(event.generationId) : undefined;
        if (record !== undefined && !joined.has(record)) place(record, scope, before, arrived, event, event.text || event.thinking || event.error);
        else if (event.role !== 'assistant') lastInput.set(scope, event.text);
        break;
      }
      case 'tool_call': {
        const isBranch = scopes.has(event.id);
        const asker = lastGeneration.get(scope);
        const start = asker?.end ?? arrived;
        const known = isBranch ? branches.get(event.id) : undefined;
        const step = known ?? { ...newStep(isBranch ? 'subagent' : 'tool', event.name), id: event.id, start };
        step.anchor = anchorOf(event);
        step.request = commandOf(event.arguments);
        unanswered.set(JSON.stringify([scope, event.id]), step);
        if (known !== undefined) {
          known.start = start ?? known.start;
          asked.set(event.id, known);
          break;
        }
        if (isBranch) branches.set(event.id, step);
        asked.set(event.id, step);
        (asker?.children ?? containerOf(scope)).push(step);
        break;
      }
      case 'retry':
        pendingRetries.set(scope, (pendingRetries.get(scope) ?? 0) + 1);
        break;
      case 'compaction':
        for (const { generationId } of event.calls ?? []) {
          const record = generationId === null ? undefined : byId.get(generationId);
          if (record !== undefined && !joined.has(record)) place(record, scope, before, arrived, event, event.summary);
        }
        break;
      case 'cache_warm': {
        const record = event.generationId === null ? undefined : byId.get(event.generationId);
        if (record !== undefined && !joined.has(record)) place(record, scope, before, arrived, event);
        break;
      }
      case 'tool_result': {
        const answered = asked.get(event.id);
        if (answered !== undefined) answered.end = arrived;
        const key = JSON.stringify([scope, event.id]);
        const step = unanswered.get(key);
        if (step !== undefined) {
          step.response = excerpt(event.text);
          step.failed = event.isError;
          unanswered.delete(key);
        }
        lastInput.set(scope, event.text);
        break;
      }
    }
  }

  for (const [scope, retries] of pendingRetries) {
    const last = lastGeneration.get(scope);
    if (last !== undefined) last.retries += retries;
  }
  pendingRetries.clear();

  for (const record of calls) {
    if (!joined.has(record)) place(record, record.subagent, null, null);
  }

  const settle = (step: Step): void => {
    step.children.forEach(settle);
    if (step.kind === 'subagent') {
      step.usd = sum(step.children.map(spent));
      step.start ??= earliestOf(step.children.map(({ start }) => start));
    }
  };
  steps.forEach(settle);

  const measured = calls.flatMap(({ usage }) => (usage === null ? [] : [usage]));
  return {
    steps,
    total: sum(steps.map(spent)),
    maxUsd: flatten(steps).reduce((widest, { usd }) => Math.max(widest, usd), 0),
    calls: calls.length,
    misses: misses.size,
    usage: {
      inputTokens: sum(measured.map(({ inputTokens }) => inputTokens)),
      outputTokens: sum(measured.map(({ outputTokens }) => outputTokens)),
      cacheReadTokens: sum(measured.map(({ cacheReadTokens }) => cacheReadTokens)),
      cacheWriteTokens: sum(measured.map(({ cacheWriteTokens }) => cacheWriteTokens)),
    },
    timed: first !== null,
    start: first,
    end: last,
  };
};

const newStep = (kind: StepKind, name: string): Step => ({
  kind,
  name,
  cost: null,
  usd: 0,
  cacheMiss: false,
  retries: 0,
  start: null,
  end: null,
  generation: null,
  id: null,
  anchor: null,
  request: null,
  response: null,
  failed: false,
  children: [],
});
