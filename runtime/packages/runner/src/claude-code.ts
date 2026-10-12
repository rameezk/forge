import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  errorMessage,
  type HarnessEvent,
  type HarnessOutput,
  type MessageEvent,
  type TokenUsage,
  type ToolCallEvent,
  type ToolResultEvent,
} from '@forge/shared';
import { underDevShell } from './devshell.ts';
import {
  NARRATION_INSTRUCTION,
  UNATTENDED_INSTRUCTION,
  type Harness,
  type HarnessIdentity,
  type HarnessInvocation,
  type HarnessRun,
  type HarnessRunSetup,
  type HarnessSinks,
} from './harness.ts';
import { spawnSandboxed, type Sandbox } from './sandbox.ts';
import { tokenCount } from './token-count.ts';

const FORBIDDEN_TOOLS = ['AskUserQuestion'];

const WITHHELD_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

export function claudeCodeEnv(
  env: Record<string, string>,
  configDir: string,
  bodiesDir: string,
): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(([name]) => !WITHHELD_ENV.includes(name)),
    ),
    CLAUDE_CONFIG_DIR: configDir,
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'none',
    OTEL_LOG_RAW_API_BODIES: `file:${bodiesDir}`,
  };
}

const BODIES_TIMEOUT_MS = 10_000;

const BODIES_POLL_MS = 20;

const VERSION_TIMEOUT_MS = 10_000;

const NON_JSON_EXCERPT_CHARS = 200;

const SYNTHETIC_MODEL = '<synthetic>';

export interface ClaudeCodeArgsOptions {
  maxCostUsd: number | null;
  extraArgs: string[];
}

export const claudeCodeArgs = (
  invocation: HarnessInvocation,
  { maxCostUsd, extraArgs }: ClaudeCodeArgsOptions,
): string[] => [
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--no-session-persistence',
  '--dangerously-skip-permissions',
  '--append-system-prompt',
  [UNATTENDED_INSTRUCTION, NARRATION_INSTRUCTION].join('\n\n'),
  '--disallowedTools',
  ...FORBIDDEN_TOOLS,
  '--model',
  invocation.model,
  ...(invocation.reasoningEffort === undefined
    ? []
    : ['--effort', invocation.reasoningEffort]),
  ...(maxCostUsd === null ? [] : ['--max-budget-usd', String(maxCostUsd)]),
  ...extraArgs,
  '--',
  invocation.prompt,
];

interface ClaudeContent {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  timestamp?: string;
  request_id?: string;
  is_error?: boolean;
  result?: unknown;
  message?: { id?: string; model?: string; content?: unknown };
}

interface ClaudeBody {
  stop_reason?: unknown;
  usage?: Record<string, unknown>;
}

interface IndexEntry {
  message_id?: unknown;
  request_id?: unknown;
  response_file?: unknown;
}

interface Recorded {
  requestId: string | null;
  stopReason: string | null;
  usage: TokenUsage;
}

const nonEmpty = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const blocksOf = (content: unknown): ClaudeContent[] =>
  Array.isArray(content) ? (content as ClaudeContent[]) : [];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

class RecordedBodies {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async of(messageId: string, signal: AbortSignal): Promise<Recorded> {
    const deadline = Date.now() + BODIES_TIMEOUT_MS;
    for (;;) {
      const recorded = this.#read(messageId);
      if (recorded !== null) return recorded;
      if (signal.aborted || Date.now() >= deadline) {
        throw new Error(
          `claude recorded no usage for its response ${messageId}, so the run's generations would be incomplete`,
        );
      }
      await sleep(BODIES_POLL_MS);
    }
  }

  #read(messageId: string): Recorded | null {
    let index: string;
    try {
      index = readFileSync(join(this.#dir, 'index.jsonl'), 'utf8');
    } catch {
      return null;
    }
    const entry = index
      .split('\n')
      .flatMap((line) => {
        const parsed = parseJson(line) as IndexEntry | null;
        return parsed !== null && parsed.message_id === messageId ? [parsed] : [];
      })
      .at(-1);
    const file = nonEmpty(entry?.response_file);
    if (entry === undefined || file === null || basename(file) !== file) return null;
    let body: ClaudeBody | null;
    try {
      body = parseJson(readFileSync(join(this.#dir, file), 'utf8')) as ClaudeBody | null;
    } catch {
      return null;
    }
    const usage = body?.usage;
    if (usage === undefined) return null;
    const inputTokens = tokenCount(usage.input_tokens);
    const outputTokens = tokenCount(usage.output_tokens);
    if (inputTokens === null || outputTokens === null) return null;
    return {
      requestId: nonEmpty(entry.request_id),
      stopReason: nonEmpty(body?.stop_reason),
      usage: {
        inputTokens,
        outputTokens,
        cacheReadTokens: tokenCount(usage.cache_read_input_tokens) ?? 0,
        cacheWriteTokens: tokenCount(usage.cache_creation_input_tokens) ?? 0,
      },
    };
  }
}

interface Turn {
  messageId: string;
  requestId: string | null;
  model: string | null;
  timestamp: string | null;
  text: string[];
  thinking: string[];
  calls: ToolCallEvent[];
}

const toolResultText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : blocksOf(content)
        .flatMap((part) =>
          part.type === 'text' && part.text !== undefined ? [part.text] : [],
        )
        .join('');

const timestampOf = (time: string | undefined): { timestamp?: string } => {
  const date = new Date(time ?? Number.NaN);
  return Number.isNaN(date.getTime()) ? {} : { timestamp: date.toISOString() };
};

class ClaudeCodeStream {
  readonly #rawEvent: HarnessSinks['rawEvent'];
  readonly #bodies: RecordedBodies;
  readonly #stop: AbortSignal;
  #turn: Turn | null = null;
  #sessionId: string | null = null;
  #outcome: { error: string | null } | null = null;
  #malformed: string | null = null;

  constructor(sinks: HarnessSinks, bodies: RecordedBodies) {
    this.#rawEvent = sinks.rawEvent;
    this.#stop = sinks.stop;
    this.#bodies = bodies;
  }

  get malformed(): string | null {
    return this.#malformed;
  }

  fail(reason: string): void {
    this.#malformed ??= reason;
  }

  async *translate(line: string): AsyncGenerator<HarnessEvent> {
    if (line.trim() === '') return;
    const parsed = parseJson(line) as ClaudeLine | null;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.fail(`claude emitted non-JSON output: ${line.slice(0, NON_JSON_EXCERPT_CHARS)}`);
      return;
    }
    this.#rawEvent(parsed);
    this.#sessionId = nonEmpty(parsed.session_id) ?? this.#sessionId;
    switch (parsed.type) {
      case 'assistant':
        yield* this.#assistant(parsed);
        return;
      case 'user':
        yield* this.#user(parsed);
        return;
      case 'result':
        yield* this.#flush();
        this.#outcome = {
          error:
            parsed.is_error === true
              ? (nonEmpty(parsed.result) ?? 'claude reported an error without saying which')
              : null,
        };
        return;
    }
  }

  async *finish(): AsyncGenerator<HarnessEvent> {
    yield* this.#flush();
  }

  result(exitFailure: Error | null): HarnessEvent {
    const error =
      this.#malformed ??
      this.#outcome?.error ??
      exitFailure?.message ??
      (this.#outcome === null ? 'claude stream ended without a final result' : null);
    return {
      type: 'result',
      status: error === null ? 'success' : 'error',
      sessionId: this.#sessionId,
      error,
    };
  }

  async *#assistant(line: ClaudeLine): AsyncGenerator<HarnessEvent> {
    const { message } = line;
    const messageId = nonEmpty(message?.id);
    if (messageId === null) {
      this.fail('claude emitted an assistant message without an id');
      return;
    }
    if (this.#turn !== null && this.#turn.messageId !== messageId) {
      yield* this.#flush();
    }
    const turn = (this.#turn ??= {
      messageId,
      requestId: null,
      model: nonEmpty(message?.model),
      timestamp: null,
      text: [],
      thinking: [],
      calls: [],
    });
    turn.requestId ??= nonEmpty(line.request_id);
    turn.timestamp ??= nonEmpty(line.timestamp);
    for (const block of blocksOf(message?.content)) {
      if (block.type === 'text' && block.text !== undefined) {
        turn.text.push(block.text);
      } else if (
        block.type === 'thinking' &&
        block.thinking !== undefined &&
        block.thinking !== ''
      ) {
        turn.thinking.push(block.thinking);
      } else if (block.type === 'tool_use') {
        turn.calls.push({
          type: 'tool_call',
          id: block.id ?? '',
          name: block.name ?? '',
          arguments: block.input,
        });
      }
    }
  }

  async *#user(line: ClaudeLine): AsyncGenerator<HarnessEvent> {
    const results = blocksOf(line.message?.content).filter(
      (block) => block.type === 'tool_result',
    );
    if (results.length === 0) return;
    yield* this.#flush();
    for (const block of results) {
      const event: ToolResultEvent = {
        type: 'tool_result',
        id: block.tool_use_id ?? '',
        isError: block.is_error === true,
        text: toolResultText(block.content),
      };
      yield event;
    }
  }

  async *#flush(): AsyncGenerator<HarnessEvent> {
    const turn = this.#turn;
    if (turn === null) return;
    this.#turn = null;
    const text = turn.text.join('');
    const thinking = turn.thinking.join('\n\n');
    const when = timestampOf(turn.timestamp ?? undefined);
    if (turn.model === SYNTHETIC_MODEL) {
      const failed: MessageEvent = {
        type: 'message',
        role: 'assistant',
        text,
        ...when,
        stopReason: 'error',
        error: text,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        generationId: null,
      };
      yield failed;
      return;
    }
    let recorded: Recorded;
    try {
      recorded = await this.#bodies.of(turn.messageId, this.#stop);
    } catch (error) {
      this.fail(errorMessage(error));
      return;
    }
    const message: MessageEvent = {
      type: 'message',
      role: 'assistant',
      text,
      ...(thinking === '' ? {} : { thinking }),
      ...when,
      ...(recorded.stopReason === null ? {} : { stopReason: recorded.stopReason }),
      usage: recorded.usage,
      generationId: recorded.requestId ?? turn.requestId ?? turn.messageId,
    };
    yield message;
    yield* turn.calls;
  }
}

const realCommand = (command: string): string => {
  const unresolved = (reason: string): Error =>
    new Error(`the harness command ${command} cannot be resolved: ${reason}`);
  if (!isAbsolute(command)) {
    throw unresolved('it is not an absolute path');
  }
  try {
    return realpathSync(command);
  } catch (cause) {
    throw unresolved(errorMessage(cause));
  }
};

const commandOutput = (
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(command, args, { env, timeout: VERSION_TIMEOUT_MS }, (error, stdout) =>
      error === null ? resolve(stdout.trim()) : reject(error),
    );
  });

export interface ClaudeCodeHarnessOptions {
  command: string;
  runsDir: string;
  maxCostUsd: number | null;
  sandbox: Sandbox;
  system: Record<string, string>;
  env: Record<string, string>;
  extraArgs?: string[];
}

export class ClaudeCodeHarness implements Harness {
  readonly #options: ClaudeCodeHarnessOptions;

  constructor(options: ClaudeCodeHarnessOptions) {
    this.#options = options;
  }

  open({ runId }: HarnessRunSetup): HarnessRun {
    const dir = join(this.#options.runsDir, runId);
    return new ClaudeCodeRun(this.#options, dir);
  }
}

class ClaudeCodeRun implements HarnessRun {
  readonly #options: ClaudeCodeHarnessOptions;
  readonly #dir: string;

  constructor(options: ClaudeCodeHarnessOptions, dir: string) {
    this.#options = options;
    this.#dir = dir;
  }

  async identity(): Promise<HarnessIdentity> {
    const { command, system, extraArgs = [] } = this.#options;
    const output = await commandOutput(realCommand(command), ['--version'], system).catch(
      (cause: unknown) => {
        process.stderr.write(
          `could not read the harness version (${errorMessage(cause)}), so the workload's fingerprint records none\n`,
        );
        return '';
      },
    );
    const version = output.split(/\s+/)[0] ?? '';
    return { version: version === '' ? null : version, args: [...extraArgs] };
  }

  async *run(
    invocation: HarnessInvocation,
    sinks: HarnessSinks,
  ): AsyncIterable<HarnessOutput> {
    const { command, sandbox, system, env, maxCostUsd, extraArgs = [] } = this.#options;
    const configDir = join(this.#dir, 'config');
    const bodiesDir = join(this.#dir, 'bodies');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(bodiesDir, { recursive: true });
    const stream = new ClaudeCodeStream(sinks, new RecordedBodies(bodiesDir));
    const { child, stdout, exited: exit } = spawnSandboxed(
      sandbox,
      realCommand(command),
      claudeCodeArgs(invocation, { maxCostUsd, extraArgs }),
      {
        name: 'claude',
        workDir: invocation.workDir,
        writableDirs: [configDir, bodiesDir],
        env: underDevShell(
          invocation.devShell,
          system,
          claudeCodeEnv(env, configDir, bodiesDir),
        ),
      },
    );
    stdout.on('error', () => undefined);
    const killOnStop = (): void => {
      child.kill('SIGKILL');
    };
    if (sinks.stop.aborted) killOnStop();
    sinks.stop.addEventListener('abort', killOnStop, { once: true });
    let drained = false;
    try {
      for await (const line of createInterface({ input: stdout, crlfDelay: Infinity })) {
        yield* stream.translate(line);
        if (stream.malformed !== null) break;
      }
      if (stream.malformed === null) {
        yield* stream.finish();
      }
      drained = stream.malformed === null;
    } finally {
      sinks.stop.removeEventListener('abort', killOnStop);
      if (!drained) {
        child.kill('SIGKILL');
        await exit;
      }
      rmSync(this.#dir, { recursive: true, force: true });
    }
    yield stream.result(await exit);
  }
}
