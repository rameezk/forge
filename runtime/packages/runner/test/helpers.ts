import { accessSync, chmodSync, constants, readFileSync, writeFileSync } from 'node:fs';
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
import type { Checkout } from '../src/harness.ts';
import type {
  Harness,
  HarnessInvocation,
  LookUpModel,
  PiExtensions,
  JsonLinesWriter,
  TranscriptWriter,
  Worker,
} from '../src/index.ts';

export const skillCheckout = (
  root: string,
  files: Record<string, string>,
): Checkout => {
  const skills = Object.entries(files).flatMap(([path, content]) => {
    const name = /^\.claude\/skills\/([^/]+)\/SKILL\.md$/.exec(path)?.[1];
    return name === undefined
      ? []
      : [{ name, file: join(root, path), lines: content.split('\n').length }];
  });
  return {
    root,
    skillPaths: [],
    projectInstructions: null,
    systemPrompt: null,
    appendSystemPrompt: null,
    skills: new Map(skills.map(({ name, file }) => [name, [file]])),
    skillLines: new Map(skills.map(({ file, lines }) => [file, lines])),
  };
};

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

export const unlisted: LookUpModel = async () => ({
  reason: 'the model is not listed',
});

export const withoutModelEntry = {
  lookUpModel: unlisted,
};

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
  provider: 'openrouter',
  model: 'anthropic/claude-opus-4',
  prompt: 'do the thing',
  ...overrides,
});

export interface FakeHarness extends Harness {
  readonly invocations: HarnessInvocation[];
}

export const NO_BASIS = { settings: null, normalize: (text: string): string => text };

export const fakeHarness = (
  events: HarnessEvent[],
  hooks: {
    beforeEach?: (index: number) => Promise<void> | void;
  } = {},
): FakeHarness => {
  const invocations: HarnessInvocation[] = [];
  return {
    invocations,
    open: () => ({
      identity: async () => ({ version: '1.0.0', args: [] }),
      fingerprintBasis: () => NO_BASIS,
      async *run(invocation: HarnessInvocation): AsyncIterable<HarnessEvent> {
        invocations.push(invocation);
        let index = 0;
        for (const event of events) {
          await hooks.beforeEach?.(index);
          index += 1;
          yield event;
        }
      },
    }),
  };
};

export const throwingHarness = (
  events: HarnessEvent[],
  error: Error,
): Harness => ({
  open: () => ({
    identity: async () => ({ version: '1.0.0', args: [] }),
      fingerprintBasis: () => NO_BASIS,
    async *run(): AsyncIterable<HarnessEvent> {
      yield* events;
      throw error;
    },
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

export const discardLines = (): JsonLinesWriter => ({
  append: () => {},
  close: () => {},
});

export const fixedClock = (times: string[]): (() => string) => {
  let index = 0;
  return () => {
    const time = times[Math.min(index, times.length - 1)];
    index += 1;
    return time as string;
  };
};

const fakePiSource = (version: string | null): string => `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const env = process.env;
if (process.argv[2] === '--version') { process.stdout.write(${JSON.stringify((version ?? '') + '\n')}); process.exit(${version === null ? 1 : 0}); }
const modelsPath = env.PI_CODING_AGENT_DIR + '/models.json';
writeFileSync(env.FAKE_PI_RECORD, JSON.stringify({ modelsJson: existsSync(modelsPath) ? readFileSync(modelsPath, 'utf8') : null, argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid, subagentInvocation: env.FORGE_PI_SUBAGENT_INVOCATION, agentDir: env.PI_CODING_AGENT_DIR, githubToken: env.GITHUB_TOKEN, nodeOptions: env.NODE_OPTIONS, env }));
process.stdout.write(readFileSync(env.FAKE_PI_OUTPUT, 'utf8'));
if (env.FAKE_PI_REQUESTS) writeFileSync(Number(env.FORGE_PI_REQUEST_RECORD_FD), readFileSync(env.FAKE_PI_REQUESTS, 'utf8').replaceAll('$CWD', process.cwd()));
if (env.FAKE_PI_STDERR) process.stderr.write(readFileSync(env.FAKE_PI_STDERR, 'utf8'));
process.exitCode = Number(env.FAKE_PI_EXIT ?? '0');
if (env.FAKE_PI_LINGER_MS) setTimeout(() => {}, Number(env.FAKE_PI_LINGER_MS));
if (env.FAKE_BWRAP_STATUS_FD) process.on('exit', (code) => writeFileSync(Number(env.FAKE_BWRAP_STATUS_FD), JSON.stringify({ 'exit-code': code }) + '\\n'));
`;

export const writeFakePi = (dir: string, version: string | null = '1.0.0'): string => {
  const path = join(dir, 'fake-pi.mjs');
  writeFileSync(path, fakePiSource(version));
  chmodSync(path, 0o755);
  return path;
};

export const commandPath = (name: string): string => {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(`${name} is not on PATH`);
};

const fakeClaudeSource = (version: string | null): string => `#!${process.execPath}
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const env = process.env;
if (process.argv[2] === '--version') { process.stdout.write(${JSON.stringify(version === null ? '' : `${version} (Claude Code)\n`)}); process.exit(${version === null ? 1 : 0}); }
const bodies = (env.OTEL_LOG_RAW_API_BODIES ?? '').replace(/^file:/, '');
const modeOf = (path) => (path ? statSync(path).mode & 0o777 : null);
const modes = { run: modeOf(dirname(env.CLAUDE_CONFIG_DIR ?? '')), config: modeOf(env.CLAUDE_CONFIG_DIR), bodies: modeOf(bodies) };
writeFileSync(env.FAKE_CLAUDE_RECORD, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid, env, modes }));
const perRun = (text) => text.replaceAll('{{WORK_DIR}}', realpathSync(process.cwd())).replaceAll('{{CONFIG_DIR}}', env.CLAUDE_CONFIG_DIR ?? '').replaceAll('{{WORK_DIR_SLUG}}', realpathSync(process.cwd()).replace(/[^a-zA-Z0-9]/g, '-'));
if (bodies && env.FAKE_CLAUDE_BODIES && existsSync(env.FAKE_CLAUDE_BODIES)) { mkdirSync(bodies, { recursive: true }); for (const file of readdirSync(env.FAKE_CLAUDE_BODIES)) { cpSync(env.FAKE_CLAUDE_BODIES + '/' + file, bodies + '/' + file); if (file.endsWith('.request.json')) writeFileSync(bodies + '/' + file, perRun(readFileSync(bodies + '/' + file, 'utf8'))); } }
if (bodies && env.FAKE_CLAUDE_INDEX === 'fifo') { rmSync(bodies + '/index.jsonl', { force: true }); execFileSync(env.FAKE_CLAUDE_MKFIFO, [bodies + '/index.jsonl']); }
if (bodies && env.FAKE_CLAUDE_INDEX === 'symlink') { rmSync(bodies + '/index.jsonl', { force: true }); symlinkSync(env.FAKE_CLAUDE_BODIES + '/index.jsonl', bodies + '/index.jsonl'); }
process.stdout.write(readFileSync(env.FAKE_CLAUDE_STREAM, 'utf8'));
process.exitCode = Number(env.FAKE_CLAUDE_EXIT ?? '0');
if (env.FAKE_CLAUDE_LINGER_MS) setTimeout(() => {}, Number(env.FAKE_CLAUDE_LINGER_MS));
if (env.FAKE_BWRAP_STATUS_FD) process.on('exit', (code) => writeFileSync(Number(env.FAKE_BWRAP_STATUS_FD), JSON.stringify({ 'exit-code': code }) + '\\n'));
`;

export const writeFakeClaude = (dir: string, version: string | null = '2.1.296'): string => {
  const path = join(dir, 'fake-claude.mjs');
  writeFileSync(path, fakeClaudeSource(version));
  chmodSync(path, 0o755);
  return path;
};

export const claudeReplay = (
  fixture: string,
  record: string,
): Record<string, string> => {
  const dir = join(import.meta.dirname, 'fixtures', 'claude-code', fixture);
  return {
    FAKE_CLAUDE_RECORD: record,
    FAKE_CLAUDE_STREAM: join(dir, 'stream.jsonl'),
    FAKE_CLAUDE_BODIES: join(dir, 'bodies'),
    FAKE_CLAUDE_EXIT: readFileSync(join(dir, 'exit.txt'), 'utf8').trim(),
  };
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
  requestRecord: join(PACKAGES, 'pi-request-record', 'src'),
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

export const PASSTHROUGH_BWRAP = `#!/bin/sh
while [ "$1" != -- ]; do
  if [ "$1" = --chdir ]; then dir=$2; fi
  shift
done
shift
cd "$dir" || exit 1
"$@"
code=$?
printf '{"exit-code": %s}\\n' "$code" >&3
exit $code
`;

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
