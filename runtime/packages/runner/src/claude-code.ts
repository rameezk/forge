import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  errorMessage,
  SkillLoadTracker,
  type CompactionEvent,
  type HarnessEvent,
  type HarnessOutput,
  type MessageEvent,
  type RetryEvent,
  type TokenUsage,
  type ToolCallEvent,
  type ToolResultEvent,
} from '@forge/shared';
import { recordOf } from '@forge/pi-request-record';
import { claudeCodeNormalizer, claudeCodeSettingsHash } from './claude-code-fingerprint.ts';
import { underDevShell } from './devshell.ts';
import {
  NARRATION_INSTRUCTION,
  UNATTENDED_INSTRUCTION,
  type Harness,
  type FingerprintBasis,
  type HarnessIdentity,
  type HarnessInvocation,
  type HarnessRun,
  type HarnessRunSetup,
  type HarnessSinks,
} from './harness.ts';
import {
  NON_JSON_EXCERPT_CHARS,
  nonEmpty,
  realCommand,
  versionOutput,
} from './harness-process.ts';
import { spawnSandboxed, type Sandbox } from './sandbox.ts';
import { tokenCount } from './token-count.ts';

const FORBIDDEN_TOOLS = ['AskUserQuestion'];

const WITHHELD_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

const MAX_SUBAGENT_DEPTH = 1;

const MAX_CONCURRENT_SUBAGENTS = 4;

const RUN_SETTINGS = JSON.stringify({
  env: {
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: String(MAX_SUBAGENT_DEPTH),
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(MAX_CONCURRENT_SUBAGENTS),
  },
});

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
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_TRACES_EXPORTER: 'none',
    OTEL_LOG_RAW_API_BODIES: `file:${bodiesDir}`,
  };
}

const BODIES_TIMEOUT_MS = 10_000;

const PRIVATE_DIR = 0o700;

const MAX_INDEX_BYTES = 16 * 1024 * 1024;

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

const BODIES_POLL_MS = 20;

const SYNTHETIC_MODEL = '<synthetic>';

const COMPACTION_SOURCE = 'compact';

const COMPACTION_HANDOFF = 'This session is being continued from a previous conversation';

export interface ClaudeCodeArgsOptions {
  maxCostUsd: number | null;
  extraArgs: string[];
}

const FORGE_INSTRUCTIONS = [UNATTENDED_INSTRUCTION, NARRATION_INSTRUCTION].join('\n\n');

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
  FORGE_INSTRUCTIONS,
  '--append-subagent-system-prompt',
  FORGE_INSTRUCTIONS,
  '--settings',
  RUN_SETTINGS,
  '--forward-subagent-text',
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
  parent_tool_use_id?: string | null;
  timestamp?: string;
  request_id?: string;
  is_error?: boolean;
  result?: unknown;
  attempt?: unknown;
  max_retries?: unknown;
  retry_delay_ms?: unknown;
  error_status?: unknown;
  error?: unknown;
  compact_metadata?: { trigger?: unknown; pre_tokens?: unknown; post_tokens?: unknown };
  message?: { id?: string; model?: string; content?: unknown };
}

interface ClaudeBody {
  stop_reason?: unknown;
  content?: unknown;
  usage?: Record<string, unknown>;
}

interface IndexEntry {
  message_id?: unknown;
  request_id?: unknown;
  request_file?: unknown;
  response_file?: unknown;
  query_source?: unknown;
}

interface Recorded {
  messageId: string | null;
  contentBlocks: number;
  requestId: string | null;
  stopReason: string | null;
  usage: TokenUsage;
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const blocksOf = (content: unknown): ClaudeContent[] =>
  Array.isArray(content) ? (content as ClaudeContent[]) : [];

const readRegularFile = (path: string, limit: number, from = 0): string | null => {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    const { size } = stat;
    if (!stat.isFile() || size > limit) return null;
    const wanted = Math.max(size - from, 0);
    const buffer = Buffer.alloc(wanted);
    let filled = 0;
    while (filled < wanted) {
      const read = readSync(fd, buffer, filled, wanted - filled, from + filled);
      if (read === 0) break;
      filled += read;
    }
    return buffer.toString('utf8', 0, filled);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

class RecordedBodies {
  readonly #dir: string;
  readonly #entries = new Map<string, IndexEntry>();
  readonly #compactions: IndexEntry[] = [];
  #offset = 0;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async of(messageId: string, signal: AbortSignal): Promise<Recorded> {
    return this.#await(
      () => this.peek(messageId),
      `its response ${messageId}`,
      signal,
    );
  }

  async nextCompaction(signal: AbortSignal): Promise<Recorded> {
    return this.#await(() => this.#peekCompaction(), 'its compaction request', signal);
  }

  hasUnclaimedCompactions(): boolean {
    this.#refresh();
    return this.#compactions.length > 0;
  }

  async #await(
    read: () => Recorded | null,
    what: string,
    signal: AbortSignal,
  ): Promise<Recorded> {
    const deadline = Date.now() + BODIES_TIMEOUT_MS;
    for (;;) {
      const recorded = read();
      if (recorded !== null) return recorded;
      if (signal.aborted || Date.now() >= deadline) {
        throw new Error(
          `claude recorded no usage for ${what}, so the run's generations would be incomplete`,
        );
      }
      await sleep(BODIES_POLL_MS);
    }
  }

  #peekCompaction(): Recorded | null {
    this.#refresh();
    const entry = this.#compactions[0];
    if (entry === undefined) return null;
    const recorded = this.#recorded(entry);
    if (recorded !== null) this.#compactions.shift();
    return recorded;
  }

  #refresh(): void {
    const added = readRegularFile(
      join(this.#dir, 'index.jsonl'),
      MAX_INDEX_BYTES,
      this.#offset,
    );
    if (added === null) return;
    const complete = added.slice(0, added.lastIndexOf('\n') + 1);
    this.#offset += Buffer.byteLength(complete);
    for (const line of complete.split('\n')) {
      const parsed = parseJson(line) as IndexEntry | null;
      if (typeof parsed?.message_id !== 'string') continue;
      this.#entries.set(parsed.message_id, parsed);
      if (parsed.query_source === COMPACTION_SOURCE) this.#compactions.push(parsed);
    }
  }

  request(messageId: string): unknown {
    this.#refresh();
    const file = nonEmpty(this.#entries.get(messageId)?.request_file);
    if (file === null || basename(file) !== file) return null;
    const text = readRegularFile(join(this.#dir, file), MAX_REQUEST_BYTES);
    return text === null ? null : parseJson(text);
  }

  peek(messageId: string): Recorded | null {
    this.#refresh();
    const entry = this.#entries.get(messageId);
    return entry === undefined ? null : this.#recorded(entry);
  }

  #recorded(entry: IndexEntry): Recorded | null {
    const file = nonEmpty(entry.response_file);
    if (file === null || basename(file) !== file) return null;
    const text = readRegularFile(join(this.#dir, file), MAX_RESPONSE_BYTES);
    if (text === null) return null;
    const body = parseJson(text) as ClaudeBody | null;
    const usage = body?.usage;
    if (typeof usage !== 'object' || usage === null) return null;
    const inputTokens = tokenCount(usage.input_tokens);
    const outputTokens = tokenCount(usage.output_tokens);
    if (inputTokens === null || outputTokens === null) return null;
    return {
      messageId: nonEmpty(entry.message_id),
      contentBlocks: blocksOf(body?.content).length,
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
  scope: string | null;
  messageId: string;
  requestId: string | null;
  model: string | null;
  timestamp: string | null;
  blocks: number;
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

const toolCall = (block: ClaudeContent): ToolCallEvent => ({
  type: 'tool_call',
  id: block.id ?? '',
  name: block.name ?? '',
  arguments: block.input,
});

const isCompactionHandoff = (line: ClaudeLine): boolean =>
  blocksOf(line.message?.content).some(
    (block) => block.type === 'text' && block.text?.startsWith(COMPACTION_HANDOFF) === true,
  );

const retryError = ({ error, error_status: status }: ClaudeLine): string | null => {
  const reason = nonEmpty(error);
  const code = tokenCount(status);
  if (code === null) return reason;
  return reason === null ? `HTTP ${code}` : `${reason} (HTTP ${code})`;
};

const scoped = <
  T extends MessageEvent | ToolCallEvent | ToolResultEvent | RetryEvent | CompactionEvent,
>(
  event: T,
  scope: string | null,
): T => (scope === null ? event : { ...event, subagent: scope });

class ClaudeCodeStream {
  readonly #rawEvent: HarnessSinks['rawEvent'];
  readonly #requestRecord: HarnessSinks['requestRecord'];
  readonly #defined = new Set<string>();
  readonly #bodies: RecordedBodies;
  readonly #stop: AbortSignal;
  readonly #turns = new Map<string | null, Turn>();
  readonly #flushed = new Set<string>();
  readonly #holders = new Map<string, string | null>();
  readonly #announced = new Set<string | null>();
  readonly #spoken = new Set<string | null>();
  #sessionId: string | null = null;
  #outcome: { error: string | null } | null = null;
  #malformed: string | null = null;

  constructor(sinks: HarnessSinks, bodies: RecordedBodies) {
    this.#rawEvent = sinks.rawEvent;
    this.#requestRecord = sinks.requestRecord;
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
        yield* this.settle();
        return;
      case 'user':
        yield* this.#user(parsed);
        return;
      case 'system':
        yield* this.#system(parsed);
        return;
      case 'result':
        yield* this.#flushAll();
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
    yield* this.#flushAll();
    while (this.malformed === null && this.#bodies.hasUnclaimedCompactions()) {
      yield* this.#compaction(null, {});
    }
  }

  get pending(): boolean {
    return this.#turns.size > 0;
  }

  async *settle(): AsyncGenerator<HarnessEvent> {
    for (const turn of [...this.#turns.values()]) {
      const recorded = this.#bodies.peek(turn.messageId);
      if (recorded !== null && recorded.contentBlocks > 0 && recorded.contentBlocks <= turn.blocks) {
        yield* this.#flush(turn.scope, recorded);
      }
    }
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
    const scope = nonEmpty(line.parent_tool_use_id);
    if (!this.#known(scope)) return;
    this.#spoken.add(scope);
    yield* this.#flushSpawner(scope);
    if (this.#flushed.has(messageId)) {
      for (const block of blocksOf(message?.content)) {
        if (block.type === 'tool_use') {
          this.#holders.set(block.id ?? '', scope);
          yield scoped(toolCall(block), scope);
        }
      }
      return;
    }
    if (this.#turns.get(scope)?.messageId !== messageId) {
      yield* this.#flush(scope);
    }
    let turn = this.#turns.get(scope);
    if (turn === undefined) {
      turn = {
        scope,
        messageId,
        requestId: null,
        model: nonEmpty(message?.model),
        timestamp: null,
        blocks: 0,
        text: [],
        thinking: [],
        calls: [],
      };
      this.#turns.set(scope, turn);
    }
    turn.requestId ??= nonEmpty(line.request_id);
    turn.timestamp ??= nonEmpty(line.timestamp);
    turn.blocks += blocksOf(message?.content).length;
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
        turn.calls.push(toolCall(block));
        this.#holders.set(block.id ?? '', scope);
      }
    }
  }

  async *#system(line: ClaudeLine): AsyncGenerator<HarnessEvent> {
    if (line.subtype !== 'api_retry' && line.subtype !== 'compact_boundary') return;
    const scope = nonEmpty(line.parent_tool_use_id);
    if (!this.#known(scope)) return;
    yield* this.#flushSpawner(scope);
    yield* this.#flush(scope);
    if (line.subtype === 'compact_boundary') {
      this.#announced.add(scope);
      const meta = line.compact_metadata;
      yield* this.#compaction(scope, {
        reason: nonEmpty(meta?.trigger),
        tokensBefore: tokenCount(meta?.pre_tokens),
        tokensAfter: tokenCount(meta?.post_tokens),
      });
      return;
    }
    const retry: RetryEvent = {
      type: 'retry',
      attempt: tokenCount(line.attempt),
      maxAttempts: tokenCount(line.max_retries),
      delayMs: tokenCount(line.retry_delay_ms),
      error: retryError(line),
    };
    yield scoped(retry, scope);
  }

  async *#compaction(
    scope: string | null,
    known: Partial<Pick<CompactionEvent, 'reason' | 'tokensBefore' | 'tokensAfter'>>,
  ): AsyncGenerator<HarnessEvent> {
    let recorded: Recorded;
    try {
      recorded = await this.#bodies.nextCompaction(this.#stop);
    } catch (error) {
      this.fail(errorMessage(error));
      return;
    }
    if (recorded.messageId !== null) this.#record({ messageId: recorded.messageId, scope });
    const { usage } = recorded;
    const compaction: CompactionEvent = {
      type: 'compaction',
      reason: known.reason ?? null,
      tokensBefore:
        known.tokensBefore ?? usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
      tokensAfter: known.tokensAfter ?? null,
      summary: null,
      error: null,
      usage,
      generationId: recorded.requestId,
    };
    yield scoped(compaction, scope);
  }

  async *#handoff(line: ClaudeLine): AsyncGenerator<HarnessEvent> {
    const scope = nonEmpty(line.parent_tool_use_id);
    if (!this.#known(scope) || !this.#spoken.has(scope)) return;
    if (this.#announced.delete(scope)) return;
    yield* this.#flushSpawner(scope);
    yield* this.#flush(scope);
    yield* this.#compaction(scope, {});
  }

  async *#user(line: ClaudeLine): AsyncGenerator<HarnessEvent> {
    const results = blocksOf(line.message?.content).filter(
      (block) => block.type === 'tool_result',
    );
    if (results.length === 0) {
      if (isCompactionHandoff(line)) yield* this.#handoff(line);
      return;
    }
    const scope = nonEmpty(line.parent_tool_use_id);
    if (!this.#known(scope)) return;
    yield* this.#flushSpawner(scope);
    yield* this.#flush(scope);
    for (const block of results) {
      const event: ToolResultEvent = {
        type: 'tool_result',
        id: block.tool_use_id ?? '',
        isError: block.is_error === true,
        text: toolResultText(block.content),
      };
      yield scoped(event, scope);
    }
  }

  async *#flushSpawner(scope: string | null): AsyncGenerator<HarnessEvent> {
    if (scope === null) return;
    const holder = this.#holders.get(scope);
    if (holder !== undefined && holder !== scope) yield* this.#flush(holder);
  }

  #known(scope: string | null): boolean {
    if (scope === null || this.#holders.has(scope)) return true;
    this.fail(`claude attributed a message to tool call ${scope}, which it never made`);
    return false;
  }

  async *#flushAll(): AsyncGenerator<HarnessEvent> {
    for (const scope of [...this.#turns.keys()]) {
      yield* this.#flush(scope);
    }
  }

  #record({ messageId, scope }: Pick<Turn, 'messageId' | 'scope'>): void {
    const body = this.#bodies.request(messageId);
    if (body === null) return;
    for (const line of recordOf(body)) {
      if (line.type === 'request') {
        this.#requestRecord(scope === null ? line : { ...line, subagent: scope });
      } else if (!this.#defined.has(line.hash)) {
        this.#defined.add(line.hash);
        this.#requestRecord(line);
      }
    }
  }

  async *#flush(
    scope: string | null,
    known?: Recorded,
  ): AsyncGenerator<HarnessEvent> {
    const turn = this.#turns.get(scope);
    if (turn === undefined) return;
    this.#turns.delete(scope);
    this.#flushed.add(turn.messageId);
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
      yield scoped(failed, scope);
      return;
    }
    let recorded: Recorded;
    try {
      recorded = known ?? (await this.#bodies.of(turn.messageId, this.#stop));
    } catch (error) {
      this.fail(errorMessage(error));
      return;
    }
    this.#record(turn);
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
    yield scoped(message, scope);
    for (const call of turn.calls) yield scoped(call, scope);
  }
}

async function* withSkillLoads(
  skillLoads: SkillLoadTracker | null,
  events: AsyncIterable<HarnessEvent>,
): AsyncGenerator<HarnessOutput> {
  for await (const event of events) {
    const load = skillLoads?.observe(event) ?? null;
    if (load !== null) yield { type: 'skill_load', ...load };
    yield event;
  }
}

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
    const output = await versionOutput(command, system);
    const version = output.split(/\s+/)[0] ?? '';
    return { version: version === '' ? null : version, args: [...extraArgs] };
  }

  fingerprintBasis({ workDir }: HarnessInvocation): FingerprintBasis {
    return {
      settings: claudeCodeSettingsHash(workDir),
      normalize: claudeCodeNormalizer({ workDir, configDir: this.#configDir }),
    };
  }

  get #configDir(): string {
    return join(this.#dir, 'config');
  }

  async *run(
    invocation: HarnessInvocation,
    sinks: HarnessSinks,
  ): AsyncIterable<HarnessOutput> {
    const { command, sandbox, system, env, maxCostUsd, extraArgs = [] } = this.#options;
    const configDir = this.#configDir;
    const bodiesDir = join(this.#dir, 'bodies');
    mkdirSync(configDir, { recursive: true, mode: PRIVATE_DIR });
    mkdirSync(bodiesDir, { recursive: true, mode: PRIVATE_DIR });
    const skillLoads =
      invocation.checkout === undefined
        ? null
        : new SkillLoadTracker(invocation.checkout);
    const promptLoad = skillLoads?.observePrompt(invocation.prompt) ?? null;
    if (promptLoad !== null) yield { type: 'skill_load', ...promptLoad };
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
      const lines = createInterface({ input: stdout, crlfDelay: Infinity })[
        Symbol.asyncIterator
      ]();
      const arm = (): Promise<IteratorResult<string>> => {
        const pending = lines.next();
        pending.catch(() => undefined);
        return pending;
      };
      let next = arm();
      for (;;) {
        const read = stream.pending
          ? await Promise.race([next, sleep(BODIES_POLL_MS).then(() => null)])
          : await next;
        if (read === null) {
          yield* withSkillLoads(skillLoads, stream.settle());
          continue;
        }
        if (read.done === true) break;
        next = arm();
        yield* withSkillLoads(skillLoads, stream.translate(read.value));
        if (stream.malformed !== null) break;
      }
      if (stream.malformed === null) {
        yield* withSkillLoads(skillLoads, stream.finish());
      }
      drained = stream.malformed === null;
    } finally {
      sinks.stop.removeEventListener('abort', killOnStop);
      if (!drained) child.kill('SIGKILL');
      await exit;
      rmSync(this.#dir, { recursive: true, force: true });
    }
    yield stream.result(await exit);
  }
}
