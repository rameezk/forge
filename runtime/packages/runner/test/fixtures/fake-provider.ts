import { once } from 'node:events';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

export interface ChatRequest {
  messages: { role: string; content: unknown }[];
}

export type Respond = (
  call: number,
  res: ServerResponse,
  request: ChatRequest,
  headers: IncomingHttpHeaders,
) => void;

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details: { cached_tokens: number; cache_write_tokens: number };
}

export const usage = (
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

export const chunk = (
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

export const usageChunk = (id: string, total: Usage) => ({
  ...chunk(id, {}),
  choices: [],
  usage: total,
});

export const sse = (res: ServerResponse, frames: unknown[], done = true): void => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const frame of frames) {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  }
  if (done) {
    res.write('data: [DONE]\n\n');
  }
  res.end();
};

export const thinkingChunks = (id: string, thinking: string): unknown[] =>
  (thinking.match(/.{1,16}/g) ?? []).map((part) =>
    chunk(id, { reasoning: part }),
  );

export const textReply = (
  id: string,
  text: string,
  total: Usage,
  thinking = '',
): unknown[] => [
  chunk(id, { role: 'assistant', content: '' }),
  ...thinkingChunks(id, thinking),
  ...(text.match(/.{1,12}/g) ?? []).map((part) => chunk(id, { content: part })),
  chunk(id, {}, 'stop'),
  usageChunk(id, total),
];

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, string>;
}

export const toolCallReply = (
  id: string,
  text: string,
  calls: ToolCall[],
  total: Usage,
  thinking = '',
): unknown[] => [
  chunk(id, { role: 'assistant', content: text }),
  ...thinkingChunks(id, thinking),
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

export const bash = (command: string, id = 'call_1'): ToolCall => ({
  id,
  name: 'bash',
  arguments: { command },
});

export const toolOnlyTurns: Respond = (call, res) =>
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

export const SUBAGENT_TASKS = {
  alpha: 'Run echo alpha and report what it printed.',
  beta: 'Say beta.',
};

export const sentToolResults = (request: ChatRequest): boolean =>
  request.messages.some((message) => message.role === 'tool');

export const mentions = (request: ChatRequest, text: string): boolean =>
  JSON.stringify(request.messages).includes(text);

export const alphaChild: Respond = (_call, res, request) =>
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

export const providerRejection = (res: ServerResponse): void => {
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      error: { code: 400, message: 'z-ai/glm-5 is not a valid model ID' },
    }),
  );
};

export const failingAlphaChild: Respond = (call, res, request, headers) => {
  if (sentToolResults(request)) {
    providerRejection(res);
    return;
  }
  alphaChild(call, res, request, headers);
};

export const betaChild: Respond = (_call, res) =>
  sse(
    res,
    textReply('gen-child-beta-1', 'Beta report: beta.', usage(500, 0, 6)),
  );

export const delegating =
  (alpha: Respond, finalText: string): Respond =>
  (call, res, request, headers) => {
    if (mentions(request, 'You are a sub-agent')) {
      (mentions(request, SUBAGENT_TASKS.alpha) ? alpha : betaChild)(
        call,
        res,
        request,
        headers,
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

export const SUBAGENTS_PROMPT =
  'Delegate two tasks to sub-agents in parallel: have one run echo alpha, and the other say beta.';

export interface Scenario {
  respond: Respond;
  prompt?: string;
}

export const scenarios: Record<string, Scenario> = {
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
              'I should run the command and read what it prints.',
            )
          : textReply(
              'gen-success-2',
              'The command printed forge. All done.',
              usage(1300, 1000, 25, 200),
              'The output is forge, so I can report it.',
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
              usage(900, 300, 8, 200),
              'The first attempt failed, so I will answer directly.',
            ),
          ),
  },
  compaction: {
    respond: (call, res, request) =>
      sse(
        res,
        mentions(request, 'context summarization assistant')
          ? textReply(
              'gen-compaction-summary',
              '## Goal\nRun echo forge and report what it printed.',
              usage(3000, 0, 20),
            )
          : call === 1
            ? toolCallReply(
                'gen-compaction-1',
                'Let me look.',
                [bash('echo forge')],
                usage(190000, 0, 30),
              )
            : textReply(
                'gen-compaction-2',
                'The command printed forge.',
                usage(2000, 0, 10),
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

export const childScenarios: Record<string, Respond> = {
  child: alphaChild,
  'child-provider-error': failingAlphaChild,
};

export const serve = async (
  respond: Respond,
): Promise<ReturnType<typeof createServer>> => {
  let calls = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (data: Buffer) => (body += data.toString()));
    req.on('end', () => {
      calls += 1;
      respond(calls, res, JSON.parse(body) as ChatRequest, req.headers);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
};

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface AnthropicToolUse {
  id: string;
  name: string;
  input: Record<string, string>;
}

export interface AnthropicTurn {
  thinking?: string;
  text?: string;
  toolUses?: AnthropicToolUse[];
}

const anthropicBlocks = ({ thinking, text, toolUses = [] }: AnthropicTurn): unknown[][] => [
  ...(thinking === undefined
    ? []
    : [[
        { type: 'thinking', thinking: '', signature: '' },
        { type: 'thinking_delta', thinking },
        { type: 'signature_delta', signature: `signed:${thinking}` },
      ]]),
  ...(text === undefined
    ? []
    : [[{ type: 'text', text: '' }, { type: 'text_delta', text }]]),
  ...toolUses.map(({ id, name, input }) => [
    { type: 'tool_use', id, name, input: {} },
    { type: 'input_json_delta', partial_json: JSON.stringify(input) },
  ]),
];

export const anthropicReply = (
  id: string,
  turn: AnthropicTurn,
  usage: AnthropicUsage,
): unknown[] => [
  {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'anthropic/claude-opus-4.5',
      content: [],
      stop_reason: null,
      usage: { ...usage, output_tokens: 1 },
    },
  },
  ...anthropicBlocks(turn).flatMap(([start, ...deltas], index) => [
    { type: 'content_block_start', index, content_block: start },
    ...deltas.map((delta) => ({ type: 'content_block_delta', index, delta })),
    { type: 'content_block_stop', index },
  ]),
  {
    type: 'message_delta',
    delta: { stop_reason: (turn.toolUses ?? []).length > 0 ? 'tool_use' : 'end_turn' },
    usage: { output_tokens: usage.output_tokens },
  },
  { type: 'message_stop' },
];

export const anthropicSse = (res: ServerResponse, events: unknown[]): void => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) {
    const { type } = event as { type: string };
    res.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
};

export const anthropicUsage = (
  input: number,
  cacheRead: number,
  cacheWrite: number,
  output: number,
): AnthropicUsage => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
});
