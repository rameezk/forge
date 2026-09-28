import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { HarnessEvent, MessageEvent } from '@forge/shared';
import type { Harness, HarnessInvocation, HarnessRun } from './harness.ts';
import type { Billing } from './openrouter.ts';

export const piArgs = (
  invocation: HarnessInvocation,
  extraArgs: string[] = [],
): string[] => [
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
  ...extraArgs,
  invocation.prompt,
];

interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface PiContent {
  type: string;
  text?: string;
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
}

const FAILED_STOP_REASONS = new Set(['error', 'aborted']);

const STDERR_TAIL_CHARS = 4000;

const textOf = (message: PiMessage): string =>
  message.content
    .flatMap((part) =>
      part.type === 'text' && part.text !== undefined ? [part.text] : [],
    )
    .join('');

const assistantMessage = (message: PiMessage): MessageEvent => ({
  type: 'message',
  role: 'assistant',
  text: textOf(message),
  usage: {
    inputTokens:
      message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
    outputTokens: message.usage.output,
  },
  costUsd: 0,
});

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

  translate(line: string): HarnessEvent | null {
    if (line.trim().length === 0) {
      return null;
    }
    const event = parseLine(line);
    if (event === null) {
      this.#malformed = `pi emitted non-JSON output: ${line.slice(0, NON_JSON_EXCERPT_CHARS)}`;
      return null;
    }
    switch (event.type) {
      case 'session':
        this.#sessionId = event.id ?? null;
        return null;
      case 'message_end':
        if (event.message?.role !== 'assistant') {
          return null;
        }
        this.#lastAssistant = event.message;
        if (event.message.responseId !== undefined) {
          this.#generationIds.push(event.message.responseId);
        } else if (tokensOf(event.message) > 0) {
          this.#unnamedGeneration = true;
        }
        return assistantMessage(event.message);
      case 'agent_end':
        this.#ended = event.willRetry === false;
        return null;
      default:
        return null;
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

export interface PiHarnessOptions {
  command: string;
  billing: Billing;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

export class PiHarness implements Harness {
  readonly #command: string;
  readonly #billing: Billing;
  readonly #extraArgs: string[];
  readonly #env: NodeJS.ProcessEnv;

  constructor(options: PiHarnessOptions) {
    this.#command = options.command;
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
    const child = spawn(this.#command, piArgs(invocation, this.#extraArgs), {
      cwd: invocation.workDir,
      env: this.#env,
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
        const event = stream.translate(line);
        if (stream.malformed) {
          break;
        }
        if (event !== null) {
          yield event;
        }
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
