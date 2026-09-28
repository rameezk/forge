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

type Respond = (call: number, res: ServerResponse) => void;

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details: { cached_tokens: number };
}

const usage = (prompt: number, cached: number, completion: number): Usage => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
  total_tokens: prompt + completion,
  prompt_tokens_details: { cached_tokens: cached },
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

const toolCallReply = (id: string, total: Usage): unknown[] => [
  chunk(id, { role: 'assistant', content: 'Let me look.' }),
  chunk(id, {
    tool_calls: [
      {
        index: 0,
        id: 'call_1',
        type: 'function',
        function: { name: 'bash', arguments: '' },
      },
    ],
  }),
  chunk(id, {
    tool_calls: [
      { index: 0, function: { arguments: '{"command":"echo forge"}' } },
    ],
  }),
  chunk(id, {}, 'tool_calls'),
  usageChunk(id, total),
];

const scenarios: Record<string, Respond> = {
  success: (call, res) =>
    sse(
      res,
      call === 1
        ? toolCallReply('gen-success-1', usage(1200, 1000, 40))
        : textReply(
            'gen-success-2',
            'The command printed forge. All done.',
            usage(1300, 1200, 25),
          ),
    ),
  'provider-error': (_call, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { code: 400, message: 'z-ai/glm-5 is not a valid model ID' },
      }),
    );
  },
  retry: (call, res) =>
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
          textReply('gen-retry-2', 'Recovered and finished.', usage(900, 0, 8)),
        ),
};

const serve = async (
  respond: Respond,
): Promise<ReturnType<typeof createServer>> => {
  let calls = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on('end', () => {
      calls += 1;
      respond(calls, res);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
};

const runPi = async (
  pi: string,
  baseUrl: string,
  key: string | undefined,
): Promise<{ stdout: string; stderr: string; code: number | null }> => {
  const home = mkdtempSync(join(tmpdir(), 'forge-record-home-'));
  const work = mkdtempSync(join(tmpdir(), 'forge-record-work-'));
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
  writeFileSync(
    join(home, '.pi', 'agent', 'models.json'),
    JSON.stringify({ providers: { openrouter: { baseUrl } } }),
  );
  const child = spawn(
    pi,
    [
      '--mode',
      'json',
      '--no-session',
      '--offline',
      '--provider',
      'openrouter',
      '--model',
      'z-ai/glm-5',
      '--thinking',
      'high',
      'Run echo forge, then say what it printed.',
    ],
    {
      cwd: work,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        ...(key === undefined ? {} : { OPENROUTER_API_KEY: key }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data: Buffer) => (stdout += data.toString()));
  child.stderr.on('data', (data: Buffer) => (stderr += data.toString()));
  const [code] = (await once(child, 'close')) as [number | null];
  return { stdout, stderr, code };
};

const record = async (pi: string, outDir: string): Promise<void> => {
  mkdirSync(outDir, { recursive: true });
  for (const [name, respond] of Object.entries(scenarios)) {
    const server = await serve(respond);
    const { port } = server.address() as AddressInfo;
    const run = await runPi(pi, `http://127.0.0.1:${port}/v1`, 'sk-fake');
    server.close();
    if (run.code !== 0) {
      throw new Error(`${name}: pi exited ${String(run.code)}: ${run.stderr}`);
    }
    writeFileSync(join(outDir, `${name}.jsonl`), run.stdout);
  }
  const preflight = await runPi(pi, 'http://127.0.0.1:9/v1', undefined);
  writeFileSync(join(outDir, 'preflight.jsonl'), preflight.stdout);
  writeFileSync(join(outDir, 'preflight.stderr'), preflight.stderr);
};

const pi = process.argv[2];
if (pi === undefined) {
  console.error('usage: node record-pi.ts <path-to-pi>');
  process.exit(1);
}
await record(pi, join(dirname(import.meta.filename), 'pi'));
