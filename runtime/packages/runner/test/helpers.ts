import { chmodSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import type {
  HarnessEvent,
  MessageEvent,
  ResultEvent,
  Store,
} from '@forge/shared';
import type {
  Harness,
  HarnessInvocation,
  LookUpListPrice,
  PiExtensions,
  TranscriptWriter,
  Worker,
} from '../src/index.ts';

export const message = (
  overrides: Partial<Omit<MessageEvent, 'type'>> = {},
): MessageEvent => ({
  type: 'message',
  role: 'assistant',
  text: 'hello',
  usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
  generationId: 'gen-1',
  ...overrides,
});

export const unlisted: LookUpListPrice = async () => ({
  reason: 'the model is not listed',
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
if (env.FAKE_BWRAP_STATUS_FD) process.on('exit', (code) => writeFileSync(Number(env.FAKE_BWRAP_STATUS_FD), JSON.stringify({ 'exit-code': code }) + '\\n'));
`;

export const writeFakePi = (dir: string): string => {
  const path = join(dir, 'fake-pi.mjs');
  writeFileSync(path, FAKE_PI);
  chmodSync(path, 0o755);
  return path;
};

const FAKE_BWRAP_RECORDER = `import { writeFileSync } from 'node:fs';
const [record, ...argv] = process.argv.slice(2);
const { PWD, SHLVL, _, __CF_USER_TEXT_ENCODING, ...env } = process.env;
writeFileSync(record, JSON.stringify({ argv, env }));
`;

const quoted = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export interface FakeBwrapOptions {
  record: string;
  harnessEnv: Record<string, string>;
  failure?: string;
}

export interface BwrapCall {
  argv: string[];
  env: Record<string, string>;
}

export const writeFakeBwrap = (
  dir: string,
  { record, harnessEnv, failure }: FakeBwrapOptions,
): string => {
  const recorder = join(dir, 'fake-bwrap-recorder.mjs');
  writeFileSync(recorder, FAKE_BWRAP_RECORDER);
  const path = join(dir, 'fake-bwrap');
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      `${quoted(process.execPath)} ${quoted(recorder)} ${quoted(record)} "$@"`,
      ...(failure === undefined ? [] : [`echo ${quoted(failure)} >&2`, 'exit 1']),
      'while [ "$1" != -- ]; do',
      '  if [ "$1" = --chdir ]; then dir=$2; fi',
      '  shift',
      'done',
      'shift',
      ...Object.entries(harnessEnv).map(
        ([name, value]) => `export ${name}=${quoted(value)}`,
      ),
      'cd "$dir" && FAKE_BWRAP_STATUS_FD=3 exec "$@"',
      '',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return path;
};

export const LOCKDOWN = [
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-themes',
  '--no-context-files',
  '--no-approve',
];

const PACKAGES = join(import.meta.dirname, '..', '..');

export const PI_EXTENSIONS: PiExtensions = {
  subagent: join(PACKAGES, 'pi-subagent', 'src'),
  modelDefaultReasoning: join(PACKAGES, 'pi-model-default-reasoning', 'src'),
};

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

export const startedDispatch = (
  store: Store,
  repository: string,
  number: number,
  runId: string,
  at: string,
): number => {
  const start = store.startDispatch(
    { repository, number, url: `https://github.com/rameezk/${repository}/issues/${number}` },
    runId,
    at,
    Number.POSITIVE_INFINITY,
  );
  assert.ok('started' in start);
  return start.started;
};

export const lockedPiPackage = (): string => {
  const piPackage = process.env.FORGE_PI_PACKAGE;
  if (piPackage === undefined) {
    throw new Error('FORGE_PI_PACKAGE is not set to the locked pi package');
  }
  return piPackage;
};

export type GenerationStats = (
  id: string,
  attempt: number,
) => { status: number; body?: unknown; delayMs?: number } | 'hang' | 'reset';

export const billedAt =
  (costs: Record<string, number>): GenerationStats =>
  (id) => {
    const cost = costs[id];
    return cost === undefined
      ? { status: 404, body: { error: { code: 404 } } }
      : { status: 200, body: { data: { id, total_cost: cost } } };
  };

export interface Lookup {
  id: string | null;
  authorization: string | undefined;
  inFlight: number;
}

export interface FakeOpenRouter {
  baseUrl: string;
  lookups: Lookup[];
  modelRequests: number;
  close: () => void;
}

const LISTED_PRICE = {
  prompt: '0.000002',
  completion: '0.00001',
  input_cache_read: '0.0000002',
  input_cache_write: '0.0000025',
};

export const LISTED_MODELS = {
  data: [
    { id: 'z-ai/glm-4.6', pricing: { prompt: '0.0000006', completion: '0.0000022' } },
    { id: 'z-ai/glm-5', pricing: LISTED_PRICE },
  ],
};

export const fakeOpenRouter = async (
  generations: GenerationStats,
  models: unknown = null,
): Promise<FakeOpenRouter> => {
  const lookups: Lookup[] = [];
  const attempts = new Map<string, number>();
  let inFlight = 0;
  const fake = { modelRequests: 0 };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake');
    if (url.pathname === '/api/v1/models') {
      fake.modelRequests += 1;
      response.writeHead(models === null ? 404 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(models ?? { error: { code: 404 } }));
      return;
    }
    const id = url.searchParams.get('id');
    inFlight += 1;
    response.on('close', () => {
      inFlight -= 1;
    });
    lookups.push({
      id,
      authorization: request.headers.authorization,
      inFlight,
    });
    const reply =
      url.pathname === '/api/v1/generation' && id !== null
        ? generations(id, (attempts.get(id) ?? 0) + 1)
        : { status: 404 };
    if (id !== null) {
      attempts.set(id, (attempts.get(id) ?? 0) + 1);
    }
    if (reply === 'hang') {
      return;
    }
    if (reply === 'reset') {
      request.socket.destroy();
      return;
    }
    const { status, body, delayMs = 0 } = reply;
    setTimeout(() => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(
        typeof body === 'string' ? body : JSON.stringify(body ?? ''),
      );
    }, delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    lookups,
    get modelRequests() {
      return fake.modelRequests;
    },
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
};
