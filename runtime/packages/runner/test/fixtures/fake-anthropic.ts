import {
  createServer,
  type IncomingMessage,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import {
  anthropicReply,
  anthropicSse,
  anthropicUsage,
} from './fake-provider.ts';

export const CLAUDE_TOKEN = 'sk-ant-oat01-forge-test-token';

export interface MessagesRequest {
  model: string;
  system?: unknown;
  messages: { role: string; content: unknown }[];
  tools?: { name: string }[];
  thinking?: unknown;
  output_config?: { effort?: string };
}

export type RespondMessages = (
  call: number,
  res: ServerResponse,
  request: MessagesRequest,
  headers: IncomingHttpHeaders,
) => void;

export interface ClaudeScenario {
  respond: RespondMessages;
  prompt?: string;
  files?: Record<string, string>;
}

export const serveMessages = async (
  respond: RespondMessages,
  requests: MessagesRequest[] = [],
): Promise<Server> => {
  let calls = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (data: Buffer) => (body += data.toString()));
    req.on('end', () => {
      if (!(req.url ?? '').startsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      calls += 1;
      const request = JSON.parse(body) as MessagesRequest;
      requests.push(request);
      respond(calls, res, request, req.headers);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
};

const sentToolResults = (request: MessagesRequest): boolean =>
  request.messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some(
        (part: { type?: string }) => part.type === 'tool_result',
      ),
  );

export const CLAUDE_USAGE_LIMIT =
  "You've hit your limit - resets 4pm (Europe/Berlin)";

export const CLAUDE_PROVIDER_ERROR =
  'claude-opus-4-5 is not a valid model ID';

const rejection = (
  res: ServerResponse,
  status: number,
  type: string,
  message: string,
): void => {
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-should-retry': 'false',
    'request-id': 'req_forge_rejected',
  });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
};

export const claudeScenarios: Record<string, ClaudeScenario> = {
  success: {
    respond: (_call, res, request) =>
      anthropicSse(
        res,
        sentToolResults(request)
          ? anthropicReply(
              'msg_forge_success_2',
              { text: 'The command printed forge. All done.' },
              anthropicUsage(300, 1000, 200, 25),
            )
          : anthropicReply(
              'msg_forge_success_1',
              {
                thinking: 'I should run the command and read what it prints.',
                text: 'Let me look.',
                toolUses: [
                  { id: 'toolu_1', name: 'Bash', input: { command: 'echo forge' } },
                ],
              },
              anthropicUsage(200, 0, 1000, 40),
            ),
      ),
  },
  'provider-error': {
    respond: (_call, res) =>
      rejection(res, 400, 'invalid_request_error', CLAUDE_PROVIDER_ERROR),
  },
  'usage-limit': {
    respond: (_call, res) =>
      rejection(res, 429, 'rate_limit_error', CLAUDE_USAGE_LIMIT),
  },
};
