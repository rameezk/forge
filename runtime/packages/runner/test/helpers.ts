import type {
  HarnessEvent,
  MessageEvent,
  ResultEvent,
} from '@forge/shared';
import type {
  Harness,
  HarnessInvocation,
  HarnessRun,
  RunCost,
  TranscriptWriter,
  Worker,
} from '../src/index.ts';

export const message = (
  overrides: Partial<Omit<MessageEvent, 'type'>> = {},
): MessageEvent => ({
  type: 'message',
  role: 'assistant',
  text: 'hello',
  usage: { inputTokens: 100, outputTokens: 40 },
  costUsd: 0.02,
  ...overrides,
});

export const result = (
  overrides: Partial<Omit<ResultEvent, 'type'>> = {},
): ResultEvent => ({
  type: 'result',
  status: 'success',
  sessionId: 'sess-1',
  error: null,
  ...overrides,
});

export const aWorker = (overrides: Partial<Worker> = {}): Worker => ({
  name: 'refiner',
  harness: 'pi',
  model: 'anthropic/claude-opus-4',
  prompt: 'do the thing',
  ...overrides,
});

export interface FakeHarness extends Harness {
  readonly invocations: HarnessInvocation[];
}

const SETTLED_COST: RunCost = { costUsd: 0.02, uncertain: false };

export const fakeHarness = (
  events: HarnessEvent[],
  hooks: {
    beforeEach?: (index: number) => Promise<void> | void;
    cost?: RunCost;
  } = {},
): FakeHarness => {
  const invocations: HarnessInvocation[] = [];
  return {
    invocations,
    run(invocation: HarnessInvocation): HarnessRun {
      invocations.push(invocation);
      return {
        events: (async function* () {
          let index = 0;
          for (const event of events) {
            await hooks.beforeEach?.(index);
            index += 1;
            yield event;
          }
        })(),
        cost: async () => hooks.cost ?? SETTLED_COST,
      };
    },
  };
};

export const throwingHarness = (
  events: HarnessEvent[],
  error: Error,
): Harness => ({
  run: (): HarnessRun => ({
    events: (async function* () {
      for (const event of events) {
        yield event;
      }
      throw error;
    })(),
    cost: async () => SETTLED_COST,
  }),
});

export interface ArrayTranscripts {
  open: (runId: string) => TranscriptWriter;
  events: (runId: string) => HarnessEvent[];
  closed: (runId: string) => boolean;
}

export const arrayTranscripts = (): ArrayTranscripts => {
  const captured = new Map<string, HarnessEvent[]>();
  const closedRefs = new Set<string>();
  return {
    open: (runId: string): TranscriptWriter => {
      const events: HarnessEvent[] = [];
      captured.set(runId, events);
      return {
        ref: `${runId}.jsonl`,
        append: (event: HarnessEvent) => {
          events.push(event);
        },
        close: () => {
          closedRefs.add(runId);
        },
      };
    },
    events: (runId: string) => captured.get(runId) ?? [],
    closed: (runId: string) => closedRefs.has(runId),
  };
};

export const fixedClock = (times: string[]): (() => string) => {
  let index = 0;
  return () => {
    const time = times[Math.min(index, times.length - 1)];
    index += 1;
    return time as string;
  };
};
