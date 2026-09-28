import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
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
    params: { task: string },
    signal: AbortSignal | undefined,
    onUpdate: ((partial: ToolResult<SubagentUpdate>) => void) | undefined,
    ctx: { cwd: string },
  ): Promise<ToolResult<SubagentDetails>>;
}

export interface ExtensionApi {
  registerTool(tool: SubagentTool): void;
}

interface ChildMessage {
  role?: string;
  content?: { type: string; text?: string }[];
  usage?: SubagentUsage;
  responseId?: string;
}

interface ChildEvent {
  type?: string;
  message?: ChildMessage;
}

const DESCRIPTION = [
  'Delegate a task to a sub-agent: a fresh agent with its own isolated context, the same model and tools, working in the same directory.',
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

export default function subagentExtension(pi: ExtensionApi): void {
  const invocation = readInvocation(process.env);
  const [command, ...args] = invocation.argv as [string, ...string[]];

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
      },
      required: ['task'],
      additionalProperties: false,
    },
    async execute(_toolCallId, { task }, _signal, onUpdate, ctx) {
      const child = spawn(
        command,
        [
          ...args,
          '--append-system-prompt',
          invocation.systemPrompt,
          `Task: ${task}`,
        ],
        { cwd: ctx.cwd, stdio: ['ignore', 'pipe', 'inherit'] },
      );
      const exited = new Promise<Error | null>((resolve) => {
        child.on('error', resolve);
        child.on('close', () => resolve(null));
      });

      const responses: SubagentResponse[] = [];
      let report = '';
      for await (const line of createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      })) {
        const event = parseJson<ChildEvent>(line);
        if (event === null) {
          continue;
        }
        onUpdate?.({ content: [], details: { event } });
        if (
          event.type === 'message_end' &&
          event.message?.role === 'assistant'
        ) {
          responses.push(responseOf(event.message));
          report = textOf(event.message);
        }
      }
      const failure = await exited;
      if (failure !== null) {
        throw failure;
      }

      return {
        content: [{ type: 'text', text: report }],
        details: { responses },
      };
    },
  });
}
