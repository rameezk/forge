import {
  createServer,
  type IncomingMessage,
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
      respond(calls, res, request);
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

export const CLAUDE_SKILL_FILES: Record<string, string> = Object.fromEntries(
  ['first-skill', 'other-skill'].map((name) => [
    `.claude/skills/${name}/SKILL.md`,
    `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\nDo the ${name} thing.\nThen report back.\n`,
  ]),
);

const subagentOf = (request: MessagesRequest): 'alpha' | 'beta' | null => {
  if (!JSON.stringify(request.system).includes('cc_is_subagent=true')) return null;
  return JSON.stringify(request.messages).includes('SUBTASK alpha') ? 'alpha' : 'beta';
};

export const subagentsScenario = (): ClaudeScenario => {
  let parentRequests = 0;
  return {
    prompt: '/first-skill start the work',
    files: CLAUDE_SKILL_FILES,
    respond: (_call, res, request) => {
      const child = subagentOf(request);
      if (child === null) {
        parentRequests += 1;
        anthropicSse(
          res,
          parentRequests === 1
            ? anthropicReply(
                'msg_forge_subagents_parent_1',
                {
                  text: 'Two subagents will take it from here.',
                  toolUses: ['alpha', 'beta'].map((name) => ({
                    id: `toolu_${name}`,
                    name: 'Agent',
                    input: {
                      description: `Subagent ${name}`,
                      subagent_type: 'general-purpose',
                      prompt: `SUBTASK ${name}`,
                    },
                  })),
                },
                anthropicUsage(200, 0, 1000, 40),
              )
            : anthropicReply(
                `msg_forge_subagents_parent_${parentRequests}`,
                { text: 'Both subagents reported. All done.' },
                anthropicUsage(300, 1000, 200, 25),
              ),
        );
        return;
      }
      anthropicSse(
        res,
        child === 'alpha' && !sentToolResults(request)
          ? anthropicReply(
              'msg_forge_subagents_alpha_1',
              {
                text: 'Loading the other skill.',
                toolUses: [
                  { id: 'toolu_skill', name: 'Skill', input: { skill: 'other-skill' } },
                ],
              },
              anthropicUsage(100, 0, 500, 20),
            )
          : anthropicReply(
              `msg_forge_subagents_${child}_${sentToolResults(request) ? 2 : 1}`,
              { text: `Report from ${child}.` },
              anthropicUsage(110, 500, 30, 12),
            ),
      );
    },
  };
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
  subagents: subagentsScenario(),
};
