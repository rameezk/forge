import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  HarnessEvent,
  MessageEvent,
  ResultEvent,
} from '@forge/shared';
import type {
  Harness,
  HarnessInvocation,
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
  generationId: 'gen-1',
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

export const fakeHarness = (
  events: HarnessEvent[],
  hooks: {
    beforeEach?: (index: number) => Promise<void> | void;
  } = {},
): FakeHarness => {
  const invocations: HarnessInvocation[] = [];
  return {
    invocations,
    async *run(invocation: HarnessInvocation): AsyncIterable<HarnessEvent> {
      invocations.push(invocation);
      let index = 0;
      for (const event of events) {
        await hooks.beforeEach?.(index);
        index += 1;
        yield event;
      }
    },
  };
};

export const throwingHarness = (
  events: HarnessEvent[],
  error: Error,
): Harness => ({
  async *run(): AsyncIterable<HarnessEvent> {
    yield* events;
    throw error;
  },
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

const FAKE_PI = `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const env = process.env;
writeFileSync(env.FAKE_PI_RECORD, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid, subagentInvocation: env.FORGE_PI_SUBAGENT_INVOCATION, agentDir: env.PI_CODING_AGENT_DIR, githubToken: env.GITHUB_TOKEN, nodeOptions: env.NODE_OPTIONS, env }));
process.stdout.write(readFileSync(env.FAKE_PI_OUTPUT, 'utf8'));
if (env.FAKE_PI_STDERR) process.stderr.write(readFileSync(env.FAKE_PI_STDERR, 'utf8'));
process.exitCode = Number(env.FAKE_PI_EXIT ?? '0');
if (env.FAKE_PI_LINGER_MS) setTimeout(() => {}, Number(env.FAKE_PI_LINGER_MS));
`;

export const writeFakePi = (dir: string): string => {
  const path = join(dir, 'fake-pi.mjs');
  writeFileSync(path, FAKE_PI);
  chmodSync(path, 0o755);
  return path;
};

export const LOCKDOWN = [
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-themes',
  '--no-context-files',
];

export const PI_CONTRACT = [
  '--mode',
  'json',
  '--no-session',
  ...LOCKDOWN,
  '--offline',
  '--provider',
  'openrouter',
  '--model',
  'z-ai/glm-5',
];

export const journaled = async <T>(
  body: () => Promise<T>,
): Promise<{ result: T; journal: string }> => {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await body(), journal: lines.join('') };
  } finally {
    process.stderr.write = write;
  }
};

export const lockedPiPackage = (): string => {
  const piPackage = process.env.FORGE_PI_PACKAGE;
  if (piPackage === undefined) {
    throw new Error('FORGE_PI_PACKAGE is not set to the locked pi package');
  }
  return piPackage;
};
