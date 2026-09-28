import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import {
  childArgs,
  SUBAGENT_INVOCATION_ENV,
  SUBAGENT_TOOL,
  type SubagentDetails,
  type SubagentInvocation,
  type SubagentResponse,
  type SubagentUpdate,
  type SubagentUsage,
} from './contract.ts';

export interface ToolResult<T> {
  content: { type: 'text'; text: string }[];
  details: T;
}

export interface SubagentTool {
  name: string;
  label: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: 'string'; description: string }>;
    required: string[];
    additionalProperties: false;
  };
  execute(
    toolCallId: string,
    params: { task: string; cwd?: string },
    signal: AbortSignal | undefined,
    onUpdate: ((partial: ToolResult<SubagentUpdate>) => void) | undefined,
    ctx: { cwd: string },
  ): Promise<ToolResult<SubagentDetails>>;
}

export interface ToolResultEvent {
  type: 'tool_result';
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  content: { type: string; text?: string }[];
  details: unknown;
  isError: boolean;
}

export type ToolResultHandler = (
  event: ToolResultEvent,
) =>
  | { isError?: boolean }
  | undefined
  | Promise<{ isError?: boolean } | undefined>;

export interface ExtensionApi {
  registerTool(tool: SubagentTool): void;
  on(event: 'tool_result', handler: ToolResultHandler): void;
}

interface ChildMessage {
  role?: string;
  content?: { type: string; text?: string }[];
  usage?: SubagentUsage;
  responseId?: string;
  stopReason?: string;
  errorMessage?: string;
}

interface ChildEvent {
  type?: string;
  message?: ChildMessage;
}

const DESCRIPTION = [
  'Delegate a task to a sub-agent: a fresh agent with its own isolated context and the same model and tools, working in your working directory or a directory inside it.',
  'It cannot see this conversation, so give it a complete, self-contained task.',
  "The sub-agent's final message is returned as this tool's result.",
  'To run sub-agents in parallel, issue several subagent calls in one message.',
].join(' ');

const parseJson = <T>(text: string): T | null => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

const readInvocation = (env: NodeJS.ProcessEnv): SubagentInvocation => {
  const invocation = parseJson<Partial<SubagentInvocation>>(
    env[SUBAGENT_INVOCATION_ENV] ?? '',
  );
  const argv = invocation?.argv;
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    !argv.every((arg) => typeof arg === 'string') ||
    typeof invocation?.systemPrompt !== 'string'
  ) {
    throw new Error(
      `${SUBAGENT_INVOCATION_ENV} must hold the child pi invocation as {argv, systemPrompt}`,
    );
  }
  return { argv, systemPrompt: invocation.systemPrompt };
};

const textOf = (message: ChildMessage): string =>
  (message.content ?? [])
    .flatMap((part) =>
      part.type === 'text' && part.text !== undefined ? [part.text] : [],
    )
    .join('');

const responseOf = (message: ChildMessage): SubagentResponse => {
  const {
    input = 0,
    output = 0,
    cacheRead = 0,
    cacheWrite = 0,
  } = message.usage ?? {};
  return {
    ...(message.responseId === undefined
      ? {}
      : { responseId: message.responseId }),
    usage: { input, output, cacheRead, cacheWrite },
  };
};

const STDERR_TAIL_CHARS = 4000;

const FAILED_STOP_REASONS = new Set(['error', 'aborted']);

const streamFailure = (last: ChildMessage | null): string | null => {
  if (last === null || !FAILED_STOP_REASONS.has(last.stopReason ?? '')) {
    return null;
  }
  return (
    last.errorMessage ?? `sub-agent stopped with reason '${last.stopReason}'`
  );
};

const failed = (
  responses: SubagentResponse[],
  error: string,
): ToolResult<SubagentDetails> => ({
  content: [{ type: 'text', text: `Sub-agent failed: ${error}` }],
  details: { responses, error },
});

const isFailure = (details: unknown): boolean =>
  typeof (details as Partial<SubagentDetails> | undefined)?.error === 'string';

const ABORTED = 'sub-agent was aborted';

const MAX_CONCURRENT_CHILDREN = 4;

const concurrencyLimit = (limit: number) => {
  let active = 0;
  const waiting: (() => void)[] = [];
  const acquire = (): Promise<void> => {
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next === undefined) {
      active -= 1;
    } else {
      next();
    }
  };
  return async <T>(work: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await work();
    } finally {
      release();
    }
  };
};

const isWithin = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
};

const confinedWorkDir = async (
  runDir: string,
  requested: string,
): Promise<string | { rejected: string }> => {
  const named = `working directory ${JSON.stringify(requested)}`;
  let target: string;
  try {
    target = await realpath(resolve(runDir, requested));
  } catch {
    return { rejected: `${named} does not exist` };
  }
  if (!isWithin(await realpath(runDir), target)) {
    return {
      rejected: `${named} is outside this run's working directory`,
    };
  }
  if (!(await stat(target)).isDirectory()) {
    return { rejected: `${named} is not a directory` };
  }
  return target;
};

const exitFailure = (
  code: number | null,
  signal: NodeJS.Signals | null,
  stderrTail: string,
): string => {
  const how =
    code === null ? `on signal ${String(signal)}` : `with code ${code}`;
  const reason = stderrTail.trim();
  return reason.length === 0
    ? `sub-agent pi exited ${how}`
    : `sub-agent pi exited ${how}: ${reason}`;
};

const runChild = async (
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: ToolResult<SubagentUpdate>) => void) | undefined,
): Promise<ToolResult<SubagentDetails>> => {
  const child = spawn(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderrTail = '';
  child.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
  });
  const exited = new Promise<string | null>((resolve) => {
    child.on('error', (error) => resolve(error.message));
    child.on('close', (code, exitSignal) =>
      resolve(code === 0 ? null : exitFailure(code, exitSignal, stderrTail)),
    );
  });
  const kill = (): void => {
    child.kill('SIGKILL');
  };
  signal?.addEventListener('abort', kill, { once: true });

  const responses: SubagentResponse[] = [];
  let last: ChildMessage | null = null;
  try {
    for await (const line of createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    })) {
      const event = parseJson<ChildEvent>(line);
      if (event === null) {
        continue;
      }
      onUpdate?.({ content: [], details: { event } });
      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        responses.push(responseOf(event.message));
        last = event.message;
      }
    }
    const exit = await exited;
    const failure =
      signal?.aborted === true ? ABORTED : (exit ?? streamFailure(last));
    if (failure !== null) {
      return failed(responses, failure);
    }
    return {
      content: [{ type: 'text', text: last === null ? '' : textOf(last) }],
      details: { responses },
    };
  } finally {
    signal?.removeEventListener('abort', kill);
  }
};

export default function subagentExtension(pi: ExtensionApi): void {
  const invocation = readInvocation(process.env);
  const [command] = invocation.argv as [string, ...string[]];
  const inSlot = concurrencyLimit(MAX_CONCURRENT_CHILDREN);

  pi.registerTool({
    name: SUBAGENT_TOOL,
    label: 'Subagent',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            'The complete, self-contained task for the sub-agent to perform.',
        },
        cwd: {
          type: 'string',
          description:
            'The directory the sub-agent works in, relative to your working directory and inside it. Defaults to your working directory.',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
    async execute(_toolCallId, { task, cwd }, signal, onUpdate, ctx) {
      const workDir =
        cwd === undefined ? ctx.cwd : await confinedWorkDir(ctx.cwd, cwd);
      if (typeof workDir !== 'string') {
        return failed([], workDir.rejected);
      }
      return inSlot(() =>
        signal?.aborted === true
          ? Promise.resolve(failed([], ABORTED))
          : runChild(
              command,
              childArgs(invocation, task),
              workDir,
              signal,
              onUpdate,
            ),
      );
    },
  });

  pi.on('tool_result', (event) =>
    event.toolName === SUBAGENT_TOOL && isFailure(event.details)
      ? { isError: true }
      : undefined,
  );
}
