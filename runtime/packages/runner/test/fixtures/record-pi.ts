import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { childArgs, SUBAGENT_INVOCATION_ENV } from '@forge/pi-subagent';
import type { HarnessInvocation } from '../../src/harness.ts';
import { piArgs, subagentInvocation } from '../../src/pi.ts';

interface ChatRequest {
  messages: { role: string; content: unknown }[];
}

type Respond = (
  call: number,
  res: ServerResponse,
  request: ChatRequest,
) => void;

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details: { cached_tokens: number; cache_write_tokens: number };
}

const usage = (
  prompt: number,
  cached: number,
  completion: number,
  written = 0,
): Usage => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
  total_tokens: prompt + completion,
  prompt_tokens_details: { cached_tokens: cached, cache_write_tokens: written },
});

const chunk = (
  id: string,
  delta: Record<string, unknown>,
  finish: string | null = null,
) => ({
  id,
  object: 'chat.completion.chunk',
  created: 1790000000,
  model: 'z-ai/glm-5',
  choices: [{ index: 0, delta, finish_reason: finish }],
});

const usageChunk = (id: string, total: Usage) => ({
  ...chunk(id, {}),
  choices: [],
  usage: total,
});

const sse = (res: ServerResponse, frames: unknown[], done = true): void => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const frame of frames) {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  }
  if (done) {
    res.write('data: [DONE]\n\n');
  }
  res.end();
};

const textReply = (id: string, text: string, total: Usage): unknown[] => [
  chunk(id, { role: 'assistant', content: '' }),
  ...(text.match(/.{1,12}/g) ?? []).map((part) => chunk(id, { content: part })),
  chunk(id, {}, 'stop'),
  usageChunk(id, total),
];

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, string>;
}

const toolCallReply = (
  id: string,
  text: string,
  calls: ToolCall[],
  total: Usage,
): unknown[] => [
  chunk(id, { role: 'assistant', content: text }),
  ...calls.flatMap((call, index) => [
    chunk(id, {
      tool_calls: [
        {
          index,
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: '' },
        },
      ],
    }),
    chunk(id, {
      tool_calls: [
        { index, function: { arguments: JSON.stringify(call.arguments) } },
      ],
    }),
  ]),
  chunk(id, {}, 'tool_calls'),
  usageChunk(id, total),
];

const bash = (command: string, id = 'call_1'): ToolCall => ({
  id,
  name: 'bash',
  arguments: { command },
});

const toolOnlyTurns: Respond = (call, res) =>
  sse(
    res,
    call === 1
      ? toolCallReply(
          'gen-tools-1',
          '',
          [bash('echo forge')],
          usage(1000, 0, 15),
        )
      : call === 2
        ? toolCallReply(
            'gen-tools-2',
            '',
            [bash('cat missing.txt', 'call_2')],
            usage(1100, 1000, 12),
          )
        : textReply(
            'gen-tools-3',
            'Done with the tools.',
            usage(1200, 1100, 8),
          ),
  );

const SUBAGENT_TASKS = {
  alpha: 'Run echo alpha and report what it printed.',
  beta: 'Say beta.',
};

const sentToolResults = (request: ChatRequest): boolean =>
  request.messages.some((message) => message.role === 'tool');

const mentions = (request: ChatRequest, text: string): boolean =>
  JSON.stringify(request.messages).includes(text);

const alphaChild: Respond = (_call, res, request) =>
  sse(
    res,
    sentToolResults(request)
      ? textReply(
          'gen-child-alpha-2',
          'Alpha report: echo alpha printed alpha.',
          usage(700, 600, 12),
        )
      : toolCallReply(
          'gen-child-alpha-1',
          'Running it.',
          [bash('echo alpha')],
          usage(600, 0, 20),
        ),
  );

const providerRejection = (res: ServerResponse): void => {
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      error: { code: 400, message: 'z-ai/glm-5 is not a valid model ID' },
    }),
  );
};

const failingAlphaChild: Respond = (call, res, request) => {
  if (sentToolResults(request)) {
    providerRejection(res);
    return;
  }
  alphaChild(call, res, request);
};

const betaChild: Respond = (_call, res) =>
  sse(
    res,
    textReply('gen-child-beta-1', 'Beta report: beta.', usage(500, 0, 6)),
  );

const delegating =
  (alpha: Respond, finalText: string): Respond =>
  (call, res, request) => {
    if (mentions(request, 'You are a sub-agent')) {
      (mentions(request, SUBAGENT_TASKS.alpha) ? alpha : betaChild)(
        call,
        res,
        request,
      );
      return;
    }
    sse(
      res,
      sentToolResults(request)
        ? textReply('gen-subagents-2', finalText, usage(1500, 1200, 10))
        : toolCallReply(
            'gen-subagents-1',
            'Delegating both.',
            [
              {
                id: 'call_alpha',
                name: 'subagent',
                arguments: { task: SUBAGENT_TASKS.alpha },
              },
              {
                id: 'call_beta',
                name: 'subagent',
                arguments: { task: SUBAGENT_TASKS.beta },
              },
            ],
            usage(1400, 1000, 30),
          ),
    );
  };

const SUBAGENTS_PROMPT =
  'Delegate two tasks to sub-agents in parallel: have one run echo alpha, and the other say beta.';

interface Scenario {
  respond: Respond;
  prompt?: string;
}

const scenarios: Record<string, Scenario> = {
  success: {
    respond: (call, res) =>
      sse(
        res,
        call === 1
          ? toolCallReply(
              'gen-success-1',
              'Let me look.',
              [bash('echo forge')],
              usage(1200, 0, 40, 1000),
            )
          : textReply(
              'gen-success-2',
              'The command printed forge. All done.',
              usage(1300, 1000, 25, 200),
            ),
      ),
  },
  'tool-calls': { respond: toolOnlyTurns },
  'provider-error': { respond: (_call, res) => providerRejection(res) },
  retry: {
    respond: (call, res) =>
      call === 1
        ? sse(
            res,
            [
              chunk('gen-retry-1', { role: 'assistant', content: 'Starting' }),
              usageChunk('gen-retry-1', usage(900, 0, 3)),
              { error: { code: 502, message: 'Provider returned error' } },
            ],
            false,
          )
        : sse(
            res,
            textReply(
              'gen-retry-2',
              'Recovered and finished.',
              usage(900, 0, 8),
            ),
          ),
  },
  subagents: {
    respond: delegating(alphaChild, 'Both sub-agents reported back.'),
    prompt: SUBAGENTS_PROMPT,
  },
  'subagent-failure': {
    respond: delegating(
      failingAlphaChild,
      'The alpha sub-agent failed; beta reported back.',
    ),
    prompt: SUBAGENTS_PROMPT,
  },
};

const childScenarios: Record<string, Respond> = {
  child: alphaChild,
  'child-provider-error': failingAlphaChild,
};

const serve = async (
  respond: Respond,
): Promise<ReturnType<typeof createServer>> => {
  let calls = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (data: Buffer) => (body += data.toString()));
    req.on('end', () => {
      calls += 1;
      respond(calls, res, JSON.parse(body) as ChatRequest);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
};

const EXTENSION = join(
  dirname(import.meta.filename),
  '..',
  '..',
  '..',
  'pi-subagent',
  'src',
);

const INVOCATION: HarnessInvocation = {
  model: 'z-ai/glm-5',
  prompt: 'Run echo forge, then say what it printed.',
  workDir: '.',
  reasoningEffort: 'high',
};

const runPi = async (
  pi: string,
  baseUrl: string,
  key: string | undefined,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number | null }> => {
  const home = mkdtempSync(join(tmpdir(), 'forge-record-home-'));
  const work = mkdtempSync(join(tmpdir(), 'forge-record-work-'));
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
  writeFileSync(
    join(home, '.pi', 'agent', 'models.json'),
    JSON.stringify({ providers: { openrouter: { baseUrl } } }),
  );
  const child = spawn(pi, args, {
    cwd: work,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      [SUBAGENT_INVOCATION_ENV]: JSON.stringify(
        subagentInvocation(pi, INVOCATION),
      ),
      ...(key === undefined ? {} : { OPENROUTER_API_KEY: key }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data: Buffer) => (stdout += data.toString()));
  child.stderr.on('data', (data: Buffer) => (stderr += data.toString()));
  const [code] = (await once(child, 'close')) as [number | null];
  return { stdout, stderr, code };
};

const recordRun = async (
  pi: string,
  respond: Respond,
  args: string[],
  out: string,
): Promise<void> => {
  const server = await serve(respond);
  const { port } = server.address() as AddressInfo;
  const run = await runPi(pi, `http://127.0.0.1:${port}/v1`, 'sk-fake', args);
  server.close();
  if (run.code !== 0) {
    throw new Error(`${out}: pi exited ${String(run.code)}: ${run.stderr}`);
  }
  writeFileSync(out, run.stdout);
};

const record = async (
  pi: string,
  outDir: string,
  childOutDir: string,
): Promise<void> => {
  mkdirSync(childOutDir, { recursive: true });
  for (const [name, respond] of Object.entries(childScenarios)) {
    await recordRun(
      pi,
      respond,
      childArgs(subagentInvocation(pi, INVOCATION), SUBAGENT_TASKS.alpha),
      join(childOutDir, `${name}.jsonl`),
    );
  }

  mkdirSync(outDir, { recursive: true });
  for (const [name, { respond, prompt = INVOCATION.prompt }] of Object.entries(
    scenarios,
  )) {
    await recordRun(
      pi,
      respond,
      piArgs({ ...INVOCATION, prompt }, EXTENSION),
      join(outDir, `${name}.jsonl`),
    );
  }
  const preflight = await runPi(
    pi,
    'http://127.0.0.1:9/v1',
    undefined,
    piArgs(INVOCATION, EXTENSION),
  );
  writeFileSync(join(outDir, 'preflight.jsonl'), preflight.stdout);
  writeFileSync(join(outDir, 'preflight.stderr'), preflight.stderr);
};

const pi = process.argv[2];
if (pi === undefined) {
  console.error('usage: node record-pi.ts <path-to-pi>');
  process.exit(1);
}
await record(
  pi,
  join(dirname(import.meta.filename), 'pi'),
  join(EXTENSION, '..', 'test', 'fixtures'),
);
