import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { HarnessEvent } from '@forge/shared';
import type { Harness, HarnessInvocation } from './harness.ts';

export const piArgs = (invocation: HarnessInvocation): string[] => [
  '--model',
  invocation.model,
  ...(invocation.reasoningEffort === undefined
    ? []
    : ['--reasoning-effort', invocation.reasoningEffort]),
  '--prompt',
  invocation.prompt,
];

export const parsePiEvent = (line: string): HarnessEvent | null => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = JSON.parse(trimmed) as { type?: unknown };
  if (parsed.type === 'message' || parsed.type === 'result') {
    return parsed as unknown as HarnessEvent;
  }
  throw new Error(`unexpected pi event type '${String(parsed.type)}'`);
};

export interface PiHarnessOptions {
  command: string;
  baseArgs?: string[];
  invocationArgs?: (invocation: HarnessInvocation) => string[];
  env?: NodeJS.ProcessEnv;
}

export class PiHarness implements Harness {
  readonly #command: string;
  readonly #baseArgs: string[];
  readonly #invocationArgs: (invocation: HarnessInvocation) => string[];
  readonly #env: NodeJS.ProcessEnv;

  constructor(options: PiHarnessOptions) {
    this.#command = options.command;
    this.#baseArgs = options.baseArgs ?? [];
    this.#invocationArgs = options.invocationArgs ?? piArgs;
    this.#env = options.env ?? process.env;
  }

  async *run(invocation: HarnessInvocation): AsyncIterable<HarnessEvent> {
    const child = spawn(
      this.#command,
      [...this.#baseArgs, ...this.#invocationArgs(invocation)],
      { env: this.#env, stdio: ['ignore', 'pipe', 'inherit'] },
    );

    const exit = new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`pi exited with code ${String(code)}`)),
      );
    });

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of lines) {
      const event = parsePiEvent(line);
      if (event !== null) {
        yield event;
      }
    }

    await exit;
  }
}
