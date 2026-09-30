import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type {
  HarnessEvent,
  MessageEvent,
  ToolCallEvent,
  ToolResultEvent,
} from '@forge/shared';
import {
  SUBAGENT_INVOCATION_ENV,
  SUBAGENT_TOOL,
  type SubagentInvocation,
  type SubagentUpdate,
} from '@forge/pi-subagent';
import { requireSkill } from './checkout.ts';
import {
  UNATTENDED_INSTRUCTION,
  type Checkout,
  type Harness,
  type HarnessInvocation,
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

const contractArgs = (invocation: HarnessInvocation): string[] => [
  '--mode',
  'json',
  '--no-session',
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-themes',
  '--no-context-files',
  '--offline',
  '--provider',
  'openrouter',
  '--model',
  invocation.model,
  ...(invocation.reasoningEffort === undefined
    ? []
    : ['--thinking', invocation.reasoningEffort]),
  ...(invocation.checkout === undefined ? [] : checkoutArgs(invocation.checkout)),
];

const SKILL_COMMAND = /^\/(\S+)([\s\S]*)$/;

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
  extension: string,
  extraArgs: string[] = [],
): string[] => [
  ...contractArgs(invocation),
  '-e',
  extension,
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
): SubagentInvocation => ({
  argv: [command, ...contractArgs(invocation)],
  systemPrompt: SUBAGENT_SYSTEM_PROMPT,
});

interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface PiContent {
  type: string;
  text?: string;
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
}

interface PiLine {
  type?: string;
  id?: string;
  message?: PiMessage;
  willRetry?: boolean;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  result?: { content?: PiContent[] };
  partialResult?: { details?: Partial<SubagentUpdate> };
}

const FAILED_STOP_REASONS = new Set(['error', 'aborted']);

const STDERR_TAIL_CHARS = 4000;

const textOf = (content: PiContent[]): string =>
  content
    .flatMap((part) =>
      part.type === 'text' && part.text !== undefined ? [part.text] : [],
    )
    .join('');

const scoped = (subagent: string | undefined): { subagent?: string } =>
  subagent === undefined ? {} : { subagent };

const assistantMessage = (
  message: PiMessage,
  subagent: string | undefined,
): MessageEvent => ({
  type: 'message',
  role: 'assistant',
  text: textOf(message.content),
  usage: {
    inputTokens:
      message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
    outputTokens: message.usage.output,
  },
  generationId:
    typeof message.responseId === 'string' && message.responseId.length > 0
      ? message.responseId
      : null,
  ...scoped(subagent),
});

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

const NON_JSON_EXCERPT_CHARS = 200;

const parseLine = (line: string): PiLine | null => {
  try {
    return JSON.parse(line) as PiLine;
  } catch {
    return null;
  }
};

class PiStream {
  #sessionId: string | null = null;
  #ended = false;
  #lastAssistant: PiMessage | null = null;
  #malformed: string | null = null;

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
    if (event.toolName !== SUBAGENT_TOOL || event.toolCallId === undefined) {
      return [];
    }
    const child = event.partialResult?.details?.event as PiLine | undefined;
    if (child?.type === 'tool_execution_end') {
      return toolResult(child, event.toolCallId);
    }
    if (child?.type !== 'message_end' || child.message?.role !== 'assistant') {
      return [];
    }
    return this.#assistant(child.message, event.toolCallId);
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

export interface PiHarnessOptions {
  command: string;
  extension: string;
  agentDir: string;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

export class PiHarness implements Harness {
  readonly #command: string;
  readonly #extension: string;
  readonly #agentDir: string;
  readonly #extraArgs: string[];
  readonly #env: NodeJS.ProcessEnv;

  constructor(options: PiHarnessOptions) {
    this.#command = options.command;
    this.#extension = options.extension;
    this.#agentDir = options.agentDir;
    this.#extraArgs = options.extraArgs ?? [];
    this.#env = options.env ?? process.env;
  }

  async *run(invocation: HarnessInvocation): AsyncIterable<HarnessEvent> {
    const stream = new PiStream();
    const args = piArgs(invocation, this.#extension, this.#extraArgs);
    const child = spawn(this.#command, args, {
      cwd: invocation.workDir,
      env: {
        ...this.#env,
        ...piEnv(this.#agentDir),
        [SUBAGENT_INVOCATION_ENV]: JSON.stringify(
          subagentInvocation(this.#command, invocation),
        ),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderrTail = '';
    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
    });

    const exit = new Promise<Error | null>((resolve) => {
      child.on('error', resolve);
      child.on('close', (code, signal) => {
        if (code === 0) {
          resolve(null);
          return;
        }
        const how =
          code === null ? `on signal ${String(signal)}` : `with code ${code}`;
        const reason = stderrTail.trim();
        resolve(
          new Error(
            reason.length === 0
              ? `pi exited ${how}`
              : `pi exited ${how}: ${reason}`,
          ),
        );
      });
    });

    let drained = false;
    try {
      const lines = createInterface({
        input: child.stdout,
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
