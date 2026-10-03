import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  errorMessage,
  type CompactionEvent,
  type HarnessEvent,
  type MessageEvent,
  type RetryEvent,
  type ToolCallEvent,
  type ToolResultEvent,
} from '@forge/shared';
import {
  SUBAGENT_INVOCATION_ENV,
  SUBAGENT_TOOL,
  type SubagentInvocation,
  type SubagentUpdate,
} from '@forge/pi-subagent';
import { requireSkill } from './checkout.ts';
import { underDevShell } from './devshell.ts';
import { spawnSandboxed, type Sandbox } from './sandbox.ts';
import { tokenCount } from './token-count.ts';
import {
  UNATTENDED_INSTRUCTION,
  type Checkout,
  type Harness,
  type HarnessInvocation,
  type RawEventSink,
} from './harness.ts';

const appended = (prompt: string): string[] => ['--append-system-prompt', prompt];

const projectInstructionArgs = (path: string): string[] => [
  ...appended(
    `<project_context>\n\nProject-specific instructions and guidelines:\n\n<project_instructions path="${path}">`,
  ),
  ...appended(path),
  ...appended('</project_instructions>\n\n</project_context>'),
];

const checkoutArgs = (checkout: Checkout): string[] => [
  ...checkout.skillPaths.flatMap((path) => ['--skill', path]),
  ...(checkout.systemPrompt === null
    ? []
    : ['--system-prompt', checkout.systemPrompt]),
  ...(checkout.appendSystemPrompt === null
    ? []
    : appended(checkout.appendSystemPrompt)),
  ...(checkout.projectInstructions === null
    ? []
    : projectInstructionArgs(checkout.projectInstructions)),
  ...appended(UNATTENDED_INSTRUCTION),
];

export interface PiExtensions {
  subagent: string;
  modelDefaultReasoning: string;
}

const reasoningArgs = (
  invocation: HarnessInvocation,
  extensions: PiExtensions,
): string[] =>
  invocation.reasoningEffort === undefined
    ? ['-e', extensions.modelDefaultReasoning]
    : ['--thinking', invocation.reasoningEffort];

const contractArgs = (
  invocation: HarnessInvocation,
  extensions: PiExtensions,
): string[] => [
  '--mode',
  'json',
  '--no-session',
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-themes',
  '--no-context-files',
  '--no-approve',
  '--offline',
  '--provider',
  'openrouter',
  '--model',
  invocation.model,
  ...reasoningArgs(invocation, extensions),
  ...(invocation.checkout === undefined ? [] : checkoutArgs(invocation.checkout)),
];

const UNTRUSTED_PROJECT_CONFIG = [
  '.pi/settings.json',
  '.pi/mcp.json',
  '.pi/extensions',
  '.pi/prompts',
  '.pi/themes',
];

const present = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const warnUnloadedProjectConfig = (checkout: Checkout | undefined): void => {
  if (checkout === undefined) {
    return;
  }
  for (const path of UNTRUSTED_PROJECT_CONFIG) {
    if (present(join(checkout.root, path))) {
      process.stderr.write(
        `the checkout's ${path} is not loaded by forge, as pi runs without trusting the project\n`,
      );
    }
  }
};

const SKILL_COMMAND = /^\/([^ ]+)([\s\S]*)$/;

const piPrompt = ({ prompt, checkout }: HarnessInvocation): string => {
  const command = SKILL_COMMAND.exec(prompt);
  if (checkout === undefined || command === null) {
    return prompt;
  }
  const [, name = '', rest = ''] = command;
  requireSkill(checkout, name);
  return `/skill:${name}${rest}`;
};

export const piArgs = (
  invocation: HarnessInvocation,
  extensions: PiExtensions,
  extraArgs: string[] = [],
): string[] => [
  ...contractArgs(invocation, extensions),
  '-e',
  extensions.subagent,
  ...extraArgs,
  piPrompt(invocation),
];

export const piEnv = (agentDir: string): NodeJS.ProcessEnv => ({
  PI_CODING_AGENT_DIR: agentDir,
});

const SUBAGENT_SYSTEM_PROMPT = [
  'You are a sub-agent. Another agent delegated the task below to you, and nobody will answer questions while you work on it.',
  'Your final message is returned verbatim to the agent that delegated the task, so make it a complete, self-contained report of what you did and found.',
  'You cannot spawn sub-agents.',
].join(' ');

export const subagentInvocation = (
  command: string,
  invocation: HarnessInvocation,
  extensions: PiExtensions,
): SubagentInvocation => ({
  argv: [command, ...contractArgs(invocation, extensions)],
  systemPrompt: SUBAGENT_SYSTEM_PROMPT,
});

interface PiUsage {
  input: unknown;
  output: unknown;
  cacheRead: unknown;
  cacheWrite: unknown;
}

interface PiContent {
  type: string;
  text?: string;
  thinking?: string;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
}

interface PiMessage {
  role: string;
  content: PiContent[];
  usage: PiUsage;
  stopReason: string;
  errorMessage?: string;
  responseId?: unknown;
  timestamp?: unknown;
}

interface PiToolResult {
  content?: PiContent[];
}

interface PiCompactionResult {
  summary?: unknown;
  tokensBefore?: unknown;
  estimatedTokensAfter?: unknown;
}

interface PiLine {
  type?: string;
  id?: string;
  message?: PiMessage;
  willRetry?: boolean;
  attempt?: unknown;
  maxAttempts?: unknown;
  delayMs?: unknown;
  errorMessage?: unknown;
  reason?: unknown;
  aborted?: unknown;
  result?: PiToolResult & PiCompactionResult;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  partialResult?: { details?: Partial<SubagentUpdate> };
}

const FAILED_STOP_REASONS = new Set(['error', 'aborted']);

const textOf = (content: PiContent[]): string =>
  content
    .flatMap((part) =>
      part.type === 'text' && part.text !== undefined ? [part.text] : [],
    )
    .join('');

const thinkingOf = (content: PiContent[]): { thinking?: string } => {
  const thinking = content
    .flatMap((part) =>
      part.type === 'thinking' && part.thinking !== undefined && part.thinking !== ''
        ? [part.thinking]
        : [],
    )
    .join('\n\n');
  return thinking === '' ? {} : { thinking };
};

const timestampOf = (time: unknown): { timestamp?: string } => {
  const date = new Date(typeof time === 'number' ? time : Number.NaN);
  return Number.isNaN(date.getTime()) ? {} : { timestamp: date.toISOString() };
};

const nonEmpty = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

const scoped = (subagent: string | undefined): { subagent?: string } =>
  subagent === undefined ? {} : { subagent };

const assistantMessage = (
  message: PiMessage,
  subagent: string | undefined,
): MessageEvent => {
  const stopReason = nonEmpty(message.stopReason);
  const error = nonEmpty(message.errorMessage);
  return {
    type: 'message',
    role: 'assistant',
    text: textOf(message.content),
    ...thinkingOf(message.content),
    ...timestampOf(message.timestamp),
    ...(stopReason === null ? {} : { stopReason }),
    ...(error === null ? {} : { error }),
    usage: {
      inputTokens: tokenCount(message.usage.input) ?? 0,
      outputTokens: tokenCount(message.usage.output) ?? 0,
      cacheReadTokens: tokenCount(message.usage.cacheRead) ?? 0,
      cacheWriteTokens: tokenCount(message.usage.cacheWrite) ?? 0,
    },
    generationId:
      typeof message.responseId === 'string' && message.responseId.length > 0
        ? message.responseId
        : null,
    ...scoped(subagent),
  };
};

const toolCalls = (
  message: PiMessage,
  subagent: string | undefined,
): ToolCallEvent[] =>
  message.content.flatMap((part) =>
    part.type === 'toolCall' &&
    typeof part.id === 'string' &&
    typeof part.name === 'string'
      ? [
          {
            type: 'tool_call',
            id: part.id,
            name: part.name,
            arguments: part.arguments ?? {},
            ...scoped(subagent),
          },
        ]
      : [],
  );

const toolResult = (
  event: PiLine,
  subagent: string | undefined,
): ToolResultEvent[] =>
  event.toolCallId === undefined
    ? []
    : [
        {
          type: 'tool_result',
          id: event.toolCallId,
          isError: event.isError === true,
          text: textOf(event.result?.content ?? []),
          ...scoped(subagent),
        },
      ];

const retry = (event: PiLine, subagent: string | undefined): RetryEvent => ({
  type: 'retry',
  attempt: tokenCount(event.attempt),
  maxAttempts: tokenCount(event.maxAttempts),
  delayMs: tokenCount(event.delayMs),
  error: nonEmpty(event.errorMessage),
  ...scoped(subagent),
});

const compactionError = (event: PiLine): string | null =>
  event.aborted === true
    ? 'compaction was aborted'
    : nonEmpty(event.errorMessage);

const compaction = (
  event: PiLine,
  subagent: string | undefined,
): CompactionEvent => ({
  type: 'compaction',
  reason: nonEmpty(event.reason),
  tokensBefore: tokenCount(event.result?.tokensBefore),
  tokensAfter: tokenCount(event.result?.estimatedTokensAfter),
  summary: nonEmpty(event.result?.summary),
  error: compactionError(event),
  ...scoped(subagent),
});

const NON_JSON_EXCERPT_CHARS = 200;

const parseLine = (line: string): PiLine | null => {
  try {
    return JSON.parse(line) as PiLine;
  } catch {
    return null;
  }
};

const subagentEventOf = (event: PiLine): PiLine | undefined =>
  event.toolName === SUBAGENT_TOOL
    ? (event.partialResult?.details?.event as PiLine | undefined)
    : undefined;

const isStreamed = (event: PiLine | undefined): boolean =>
  event?.type === 'message_update' ||
  (event?.type === 'tool_execution_update' &&
    event.toolName !== SUBAGENT_TOOL);

class PiStream {
  readonly #rawEvents: RawEventSink;
  #sessionId: string | null = null;
  #ended = false;
  #lastAssistant: PiMessage | null = null;
  #malformed: string | null = null;

  constructor(rawEvents: RawEventSink) {
    this.#rawEvents = rawEvents;
  }

  get malformed(): boolean {
    return this.#malformed !== null;
  }

  translate(line: string): HarnessEvent[] {
    if (line.trim().length === 0) {
      return [];
    }
    const event = parseLine(line);
    if (event === null) {
      this.#malformed = `pi emitted non-JSON output: ${line.slice(0, NON_JSON_EXCERPT_CHARS)}`;
      return [];
    }
    if (!isStreamed(event) && !isStreamed(subagentEventOf(event))) {
      this.#rawEvents(event);
    }
    switch (event.type) {
      case 'session':
        this.#sessionId = event.id ?? null;
        return [];
      case 'message_end':
        if (event.message?.role !== 'assistant') {
          return [];
        }
        this.#lastAssistant = event.message;
        return this.#assistant(event.message, undefined);
      case 'tool_execution_end':
        return toolResult(event, undefined);
      case 'tool_execution_update':
        return this.#subagentEvent(event);
      case 'auto_retry_start':
        return [retry(event, undefined)];
      case 'compaction_end':
        return [compaction(event, undefined)];
      case 'agent_start':
        this.#ended = false;
        return [];
      case 'agent_end':
        this.#ended = event.willRetry === false;
        return [];
      default:
        return [];
    }
  }

  #assistant(message: PiMessage, subagent: string | undefined): HarnessEvent[] {
    return [assistantMessage(message, subagent), ...toolCalls(message, subagent)];
  }

  #subagentEvent(event: PiLine): HarnessEvent[] {
    const child = subagentEventOf(event);
    if (child === undefined || event.toolCallId === undefined) {
      return [];
    }
    switch (child.type) {
      case 'tool_execution_end':
        return toolResult(child, event.toolCallId);
      case 'auto_retry_start':
        return [retry(child, event.toolCallId)];
      case 'compaction_end':
        return [compaction(child, event.toolCallId)];
      case 'message_end':
        return child.message?.role === 'assistant'
          ? this.#assistant(child.message, event.toolCallId)
          : [];
      default:
        return [];
    }
  }

  result(exitFailure: Error | null): HarnessEvent {
    const error = this.#malformed ?? exitFailure?.message ?? this.#error();
    return {
      type: 'result',
      status: error === null ? 'success' : 'error',
      sessionId: this.#sessionId,
      error,
    };
  }

  #error(): string | null {
    if (!this.#ended) {
      return 'pi stream ended without a final agent_end';
    }
    const last = this.#lastAssistant;
    if (last === null || !FAILED_STOP_REASONS.has(last.stopReason)) {
      return null;
    }
    return last.errorMessage ?? `pi stopped with reason '${last.stopReason}'`;
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

export interface PiHarnessOptions {
  command: string;
  extensions: PiExtensions;
  agentDir: string;
  sandbox: Sandbox;
  system: Record<string, string>;
  env: Record<string, string>;
  extraArgs?: string[];
}

export class PiHarness implements Harness {
  readonly #command: string;
  readonly #extensions: PiExtensions;
  readonly #agentDir: string;
  readonly #sandbox: Sandbox;
  readonly #extraArgs: string[];
  readonly #system: Record<string, string>;
  readonly #env: Record<string, string>;

  constructor(options: PiHarnessOptions) {
    this.#command = options.command;
    this.#extensions = options.extensions;
    this.#agentDir = options.agentDir;
    this.#sandbox = options.sandbox;
    this.#extraArgs = options.extraArgs ?? [];
    this.#system = options.system;
    this.#env = options.env;
  }

  async *run(
    invocation: HarnessInvocation,
    rawEvents: RawEventSink,
  ): AsyncIterable<HarnessEvent> {
    const stream = new PiStream(rawEvents);
    const command = realCommand(this.#command);
    warnUnloadedProjectConfig(invocation.checkout);
    const args = piArgs(invocation, this.#extensions, this.#extraArgs);
    const { child, stdout, exited: exit } = spawnSandboxed(
      this.#sandbox,
      command,
      args,
      {
        name: 'pi',
        workDir: invocation.workDir,
        env: underDevShell(invocation.devShell, this.#system, {
          ...this.#env,
          ...piEnv(this.#agentDir),
          [SUBAGENT_INVOCATION_ENV]: JSON.stringify(
            subagentInvocation(command, invocation, this.#extensions),
          ),
        }),
      },
    );

    let drained = false;
    try {
      const lines = createInterface({
        input: stdout,
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        const events = stream.translate(line);
        if (stream.malformed) {
          break;
        }
        yield* events;
      }
      drained = !stream.malformed;
    } finally {
      if (!drained) {
        child.kill('SIGKILL');
        await exit;
      }
    }

    yield stream.result(await exit);
  }
}
