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
import type { Harness, HarnessInvocation, HarnessRun } from './harness.ts';
import type { Billing } from './openrouter.ts';

const contractArgs = (invocation: HarnessInvocation): string[] => [
  '--mode',
  'json',
  '--no-session',
  '--offline',
  '--provider',
  'openrouter',
  '--model',
  invocation.model,
  ...(invocation.reasoningEffort === undefined
    ? []
    : ['--thinking', invocation.reasoningEffort]),
];

export const piArgs = (
  invocation: HarnessInvocation,
  extension: string,
  extraArgs: string[] = [],
): string[] => [
  ...contractArgs(invocation),
  '-e',
  extension,
  ...extraArgs,
  invocation.prompt,
];

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
  id?: string;
  name?: string;
  arguments?: unknown;
}

interface PiMessage {
  role: string;
  content: PiContent[];
  usage: PiUsage;
  stopReason: string;
  errorMessage?: string;
  responseId?: string;
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
  costUsd: 0,
  ...scoped(subagent),
});

const TOOL_PAYLOAD_CAP_CHARS = 32 * 1024;

const capped = (text: string): string =>
  text.length <= TOOL_PAYLOAD_CAP_CHARS
    ? text
    : `${text.slice(0, TOOL_PAYLOAD_CAP_CHARS)}\n[truncated ${text.length - TOOL_PAYLOAD_CAP_CHARS} characters]`;

const cappedArguments = (value: unknown): unknown => {
  const json = JSON.stringify(value) ?? '';
  return json.length <= TOOL_PAYLOAD_CAP_CHARS ? value : capped(json);
};

const toolCalls = (
  message: PiMessage,
  subagent: string | undefined,
): ToolCallEvent[] =>
  message.content.flatMap((part) =>
    part.type === 'toolCall' && part.id !== undefined && part.name !== undefined
      ? [
          {
            type: 'tool_call',
            id: part.id,
            name: part.name,
            arguments: cappedArguments(part.arguments),
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
          text: capped(textOf(event.result?.content ?? [])),
          ...scoped(subagent),
        },
      ];

const tokensOf = ({ usage }: PiMessage): number =>
  usage.input + usage.output + usage.cacheRead + usage.cacheWrite;

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
  readonly #generationIds: string[] = [];
  #unnamedGeneration = false;

  get generationIds(): string[] {
    return this.#generationIds;
  }

  get unnamedGeneration(): boolean {
    return this.#unnamedGeneration;
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

  #generation(message: PiMessage, subagent: string | undefined): MessageEvent {
    if (message.responseId !== undefined) {
      this.#generationIds.push(message.responseId);
    } else if (tokensOf(message) > 0) {
      this.#unnamedGeneration = true;
    }
    return assistantMessage(message, subagent);
  }

  #assistant(message: PiMessage, subagent: string | undefined): HarnessEvent[] {
    return [
      this.#generation(message, subagent),
      ...toolCalls(message, subagent),
    ];
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
  billing: Billing;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

export class PiHarness implements Harness {
  readonly #command: string;
  readonly #extension: string;
  readonly #billing: Billing;
  readonly #extraArgs: string[];
  readonly #env: NodeJS.ProcessEnv;

  constructor(options: PiHarnessOptions) {
    this.#command = options.command;
    this.#extension = options.extension;
    this.#billing = options.billing;
    this.#extraArgs = options.extraArgs ?? [];
    this.#env = options.env ?? process.env;
  }

  run(invocation: HarnessInvocation): HarnessRun {
    const stream = new PiStream();
    return {
      events: this.#events(invocation, stream),
      cost: async () => {
        const cost = await this.#billing.cost(stream.generationIds);
        return stream.unnamedGeneration ? { ...cost, uncertain: true } : cost;
      },
    };
  }

  async *#events(
    invocation: HarnessInvocation,
    stream: PiStream,
  ): AsyncIterable<HarnessEvent> {
    const args = piArgs(invocation, this.#extension, this.#extraArgs);
    const child = spawn(this.#command, args, {
      cwd: invocation.workDir,
      env: {
        ...this.#env,
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
