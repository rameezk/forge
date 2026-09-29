import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import {
  parseTranscript,
  Store,
  type MessageEvent,
  type RunRecord,
} from '@forge/shared';
import type { WorkerConfig } from '../src/index.ts';
import { main } from '../src/main.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'pi');

const fixture = (name: string): string => join(FIXTURES, name);

const EXTENSION = join(import.meta.dirname, '..', '..', 'pi-subagent', 'src');

const FAKE_PI = `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const env = process.env;
writeFileSync(env.FAKE_PI_RECORD, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid, subagentInvocation: env.FORGE_PI_SUBAGENT_INVOCATION }));
process.stdout.write(readFileSync(env.FAKE_PI_OUTPUT, 'utf8'));
if (env.FAKE_PI_STDERR) process.stderr.write(readFileSync(env.FAKE_PI_STDERR, 'utf8'));
process.exitCode = Number(env.FAKE_PI_EXIT ?? '0');
if (env.FAKE_PI_LINGER_MS) setTimeout(() => {}, Number(env.FAKE_PI_LINGER_MS));
`;

type GenerationStats = (
  id: string,
  attempt: number,
) => { status: number; body?: unknown; delayMs?: number } | 'hang' | 'reset';

const billedAt =
  (costs: Record<string, number>): GenerationStats =>
  (id) => {
    const cost = costs[id];
    return cost === undefined
      ? { status: 404, body: { error: { code: 404 } } }
      : { status: 200, body: { data: { id, total_cost: cost } } };
  };

const BILLED_BY_ID = {
  'gen-success-1': 0.0125,
  'gen-success-2': 0.0375,
  'gen-retry-1': 0.002,
  'gen-retry-2': 0.004,
  'gen-subagents-1': 0.5,
  'gen-subagents-2': 0.25,
  'gen-child-alpha-1': 0.125,
  'gen-child-alpha-2': 0.0625,
  'gen-child-beta-1': 0.03125,
};

const OPENROUTER_KEY = 'sk-or-test';

interface Lookup {
  id: string | null;
  authorization: string | undefined;
  inFlight: number;
}

const fakeOpenRouter = async (
  generations: GenerationStats,
): Promise<{ baseUrl: string; lookups: Lookup[]; close: () => void }> => {
  const lookups: Lookup[] = [];
  const attempts = new Map<string, number>();
  let inFlight = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake');
    const id = url.searchParams.get('id');
    inFlight += 1;
    response.on('close', () => {
      inFlight -= 1;
    });
    lookups.push({
      id,
      authorization: request.headers.authorization,
      inFlight,
    });
    const reply =
      url.pathname === '/api/v1/generation' && id !== null
        ? generations(id, (attempts.get(id) ?? 0) + 1)
        : { status: 404 };
    if (id !== null) {
      attempts.set(id, (attempts.get(id) ?? 0) + 1);
    }
    if (reply === 'hang') {
      return;
    }
    if (reply === 'reset') {
      request.socket.destroy();
      return;
    }
    const { status, body, delayMs = 0 } = reply;
    setTimeout(() => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(
        typeof body === 'string' ? body : JSON.stringify(body ?? ''),
      );
    }, delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    lookups,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
};

interface Scenario {
  output: string;
  generations?: GenerationStats;
  openRouterBaseUrl?: string;
  openRouterKey?: string;
  worker?: Partial<WorkerConfig>;
  harnessArgs?: string[];
  stderr?: string;
  exit?: number;
  lingerMs?: number;
}

interface Outcome {
  code: number;
  stateDir: string;
  run: RunRecord;
  transcript: string;
  pi: {
    argv: string[];
    cwd: string;
    pid: number;
    subagentInvocation: string | undefined;
  };
  lookups: Lookup[];
}

const runWorker = async (scenario: Scenario): Promise<Outcome> => {
  const stateDir = mkdtempSync(join(tmpdir(), 'forge-main-'));
  const fakePi = join(stateDir, 'fake-pi.mjs');
  writeFileSync(fakePi, FAKE_PI);
  chmodSync(fakePi, 0o755);
  const record = join(stateDir, 'pi-call.json');

  const configPath = join(stateDir, 'runtime.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      harnesses: {
        pi: {
          command: fakePi,
          ...(scenario.harnessArgs === undefined
            ? {}
            : { args: scenario.harnessArgs }),
        },
      },
      workers: {
        refiner: {
          harness: 'pi',
          model: 'z-ai/glm-5',
          prompt: 'refine the spec',
          ...scenario.worker,
        },
      },
    }),
  );

  const openRouter = await fakeOpenRouter(
    scenario.generations ?? billedAt(BILLED_BY_ID),
  );
  const code = await main(['refiner'], {
    OPENROUTER_BASE_URL: scenario.openRouterBaseUrl ?? openRouter.baseUrl,
    OPENROUTER_API_KEY: scenario.openRouterKey ?? OPENROUTER_KEY,
    FORGE_RUNTIME_CONFIG: configPath,
    FORGE_STATE_DIR: stateDir,
    FORGE_PI_SUBAGENT_EXTENSION: EXTENSION,
    FAKE_PI_RECORD: record,
    FAKE_PI_OUTPUT: scenario.output,
    FAKE_PI_EXIT: String(scenario.exit ?? 0),
    ...(scenario.stderr === undefined
      ? {}
      : { FAKE_PI_STDERR: scenario.stderr }),
    ...(scenario.lingerMs === undefined
      ? {}
      : { FAKE_PI_LINGER_MS: String(scenario.lingerMs) }),
  }).finally(openRouter.close);

  const transcripts = readdirSync(join(stateDir, 'transcripts'));
  assert.equal(transcripts.length, 1);
  const runId = basename(transcripts[0] as string, '.jsonl');
  const store = Store.open(join(stateDir, 'forge.db'));
  const run = store.getRun(runId);
  store.close();
  assert.ok(run);

  return {
    code,
    stateDir,
    run,
    transcript: readFileSync(
      join(stateDir, 'transcripts', `${runId}.jsonl`),
      'utf8',
    ),
    pi: JSON.parse(readFileSync(record, 'utf8')) as Outcome['pi'],
    lookups: openRouter.lookups,
  };
};

const outputFile = (contents: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'forge-output-')), 'pi.jsonl');
  writeFileSync(path, contents);
  return path;
};

const withGenerations = (name: string, ids: string[]): string => {
  const lines = readFileSync(fixture(name), 'utf8').split('\n');
  const end = lines.findIndex((line) => line.includes('"type":"agent_end"'));
  const assistant = lines.findLast(
    (line, index) =>
      index < end &&
      line.includes('"type":"message_end"') &&
      line.includes('"responseId"'),
  );
  assert.ok(end > 0 && assistant !== undefined);
  const generations = ids.map((id) =>
    assistant.replace(/"responseId":"[^"]*"/, `"responseId":"${id}"`),
  );
  return outputFile(
    [...lines.slice(0, end), ...generations, ...lines.slice(end)].join('\n'),
  );
};

const cutBefore = (name: string, eventType: string): string => {
  const lines = readFileSync(fixture(name), 'utf8').split('\n');
  const cut = lines.findIndex((line) => line.includes(`"type":"${eventType}"`));
  assert.ok(cut > 0);
  return outputFile(`${lines.slice(0, cut).join('\n')}\n`);
};

const journaled = async <T>(
  body: () => Promise<T>,
): Promise<{ result: T; journal: string }> => {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await body(), journal: lines.join('') };
  } finally {
    process.stderr.write = write;
  }
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sessionIdOf = (output: string): string =>
  (
    JSON.parse(readFileSync(output, 'utf8').split('\n')[0] as string) as {
      id: string;
    }
  ).id;

test('given recorded pi output of a successful multi-message run with tool, turn and streaming events, and an OpenRouter billing each generation, when the worker runs, then the events forge does not consume are skipped and the run is success with summed full-prompt usage, the session id, a readable transcript, and the summed billed cost looked up with the runner key', async () => {
  const output = fixture('success.jsonl');

  const { code, run, transcript, lookups } = await runWorker({ output });

  assert.equal(code, 0);
  assert.equal(run.status, 'success');
  assert.equal(run.error, null);
  assert.equal(run.inputTokens, 1200 + 1300);
  assert.equal(run.outputTokens, 40 + 25);
  assert.equal(run.sessionId, sessionIdOf(output));
  assert.equal(run.costUsd, 0.0125 + 0.0375);
  assert.equal(run.costStatus, 'billed');
  assert.deepEqual(lookups.map((lookup) => lookup.id).sort(), [
    'gen-success-1',
    'gen-success-2',
  ]);
  for (const lookup of lookups) {
    assert.equal(lookup.authorization, `Bearer ${OPENROUTER_KEY}`);
  }
  assert.match(transcript, /Let me look\./);
  assert.match(transcript, /The command printed forge\. All done\./);
});

test('given a recorded run where the parent makes two parallel subagent calls and an OpenRouter billing every generation, when the worker runs, then its tokens and billed cost are the sum of the parent and both children, each generation looked up once by its response id', async () => {
  const { code, run, lookups } = await runWorker({
    output: fixture('subagents.jsonl'),
  });

  assert.equal(code, 0);
  assert.equal(run.status, 'success');
  assert.equal(run.inputTokens, 1400 + 1500 + (600 + 700) + 500);
  assert.equal(run.outputTokens, 30 + 10 + (20 + 12) + 6);
  assert.equal(run.costUsd, 0.5 + 0.25 + (0.125 + 0.0625) + 0.03125);
  assert.equal(run.costStatus, 'billed');
  assert.deepEqual(lookups.map((lookup) => lookup.id).sort(), [
    'gen-child-alpha-1',
    'gen-child-alpha-2',
    'gen-child-beta-1',
    'gen-subagents-1',
    'gen-subagents-2',
  ]);
});

test('given a recorded run with two parallel subagent calls, when the transcript is written, then each child message carries its subagent scope and the parent messages carry none', async () => {
  const { transcript } = await runWorker({
    output: fixture('subagents.jsonl'),
  });

  const messages = parseTranscript(transcript).filter(
    (event): event is MessageEvent => event.type === 'message',
  );
  const textsIn = (scope: string | undefined) =>
    messages
      .filter((message) => message.subagent === scope)
      .map((message) => message.text);
  assert.deepEqual(textsIn('call_alpha'), [
    'Running it.',
    'Alpha report: echo alpha printed alpha.',
  ]);
  assert.deepEqual(textsIn('call_beta'), ['Beta report: beta.']);
  assert.deepEqual(textsIn(undefined), [
    'Delegating both.',
    'Both sub-agents reported back.',
  ]);
  for (const message of messages.filter((m) => m.subagent === undefined)) {
    assert.ok(!Object.hasOwn(message, 'subagent'));
  }
});

test('given a recorded run whose agent calls bash in turns with no text, one call failing, when the transcript is written, then each call is recorded with its arguments and each result with its output and error flag, in stream order', async () => {
  const { code, run, transcript } = await runWorker({
    output: fixture('tool-calls.jsonl'),
  });

  assert.equal(code, 0);
  assert.equal(run.inputTokens, 1000 + 1100 + 1200);
  const toolEvents = parseTranscript(transcript).filter(
    (event) => event.type === 'tool_call' || event.type === 'tool_result',
  );
  assert.deepEqual(toolEvents, [
    {
      type: 'tool_call',
      id: 'call_1',
      name: 'bash',
      arguments: { command: 'echo forge' },
    },
    { type: 'tool_result', id: 'call_1', isError: false, text: 'forge\n' },
    {
      type: 'tool_call',
      id: 'call_2',
      name: 'bash',
      arguments: { command: 'cat missing.txt' },
    },
    {
      type: 'tool_result',
      id: 'call_2',
      isError: true,
      text: 'cat: missing.txt: No such file or directory\n\n\nCommand exited with code 1',
    },
  ]);
});

test('given an agent whose tool arguments, tool output and reply contain the OpenRouter key, including where an oversized output is cut, when the transcript is written, then the key never reaches it and each occurrence is marked redacted', async () => {
  const cap = 32 * 1024;
  const straddling = `${'a'.repeat(cap - 4)}${OPENROUTER_KEY}${'a'.repeat(100)}`;
  const { transcript } = await runWorker({
    output: outputFile(
      readFileSync(fixture('tool-calls.jsonl'), 'utf8')
        .replaceAll(
          '"command":"echo forge"',
          `"command":"echo ${OPENROUTER_KEY}"`,
        )
        .replaceAll(
          '"text":"forge\\n"',
          `"text":"OPENROUTER_API_KEY=${OPENROUTER_KEY}\\n"`,
        )
        .replaceAll(
          '"text":"cat: missing.txt: No such file or directory\\n\\n\\nCommand exited with code 1"',
          `"text":"${straddling}"`,
        )
        .replaceAll(
          '"text":"Done with the tools."',
          `"text":"The key is ${OPENROUTER_KEY}."`,
        ),
    ),
  });

  assert.doesNotMatch(transcript, /sk-o/);
  const events = parseTranscript(transcript);
  assert.deepEqual(
    events.find((event) => event.type === 'tool_call' && event.id === 'call_1'),
    {
      type: 'tool_call',
      id: 'call_1',
      name: 'bash',
      arguments: { command: 'echo [redacted]' },
    },
  );
  const resultText = (id: string) =>
    events.find((event) => event.type === 'tool_result' && event.id === id);
  assert.deepEqual(resultText('call_1'), {
    type: 'tool_result',
    id: 'call_1',
    isError: false,
    text: 'OPENROUTER_API_KEY=[redacted]\n',
  });
  assert.equal(
    (resultText('call_2') as { text: string }).text,
    `${'a'.repeat(cap - 4)}[red\n[truncated ${straddling.length - OPENROUTER_KEY.length + '[redacted]'.length - cap} characters]`,
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === 'message' && event.text === 'The key is [redacted].',
    ),
  );
});

test('given pi failing with the OpenRouter key in its stderr, when the worker runs, then the recorded run error and transcript carry the reason with the key redacted', async () => {
  const stderr = outputFile(`boom: rejected key ${OPENROUTER_KEY}\n`);
  const { run, transcript } = await journaled(() =>
    runWorker({
      output: fixture('preflight.jsonl'),
      stderr,
      exit: 1,
    }),
  ).then(({ result }) => result);

  assert.equal(run.status, 'error');
  assert.match(run.error ?? '', /boom: rejected key \[redacted\]/);
  assert.doesNotMatch(run.error ?? '', /sk-or-test/);
  assert.doesNotMatch(transcript, /sk-or-test/);
});

test('given a key whose leading characters also follow a backslash in an escaped argument, and arguments that contain the key only across a newline, when the worker runs, then the run succeeds and the arguments are recorded unchanged', async () => {
  const key = 'nkey-0123456789';
  const { code, run, transcript } = await runWorker({
    openRouterKey: key,
    output: outputFile(
      readFileSync(fixture('tool-calls.jsonl'), 'utf8').replaceAll(
        '"command":"echo forge"',
        '"command":"echo\\nkey-0123456789"',
      ),
    ),
  });

  assert.equal(code, 0);
  assert.equal(run.status, 'success');
  assert.deepEqual(
    parseTranscript(transcript).find(
      (event) => event.type === 'tool_call' && event.id === 'call_1',
    ),
    {
      type: 'tool_call',
      id: 'call_1',
      name: 'bash',
      arguments: { command: 'echo\nkey-0123456789' },
    },
  );
});

test('given pi output whose tool call parts have a non-string name or id, or no arguments, when the transcript is written, then malformed calls are skipped and a call without arguments is recorded with none', async () => {
  const { code, transcript } = await runWorker({
    output: outputFile(
      readFileSync(fixture('tool-calls.jsonl'), 'utf8')
        .split('\n')
        .map((line) =>
          line.startsWith('{"type":"message_end"')
            ? line.replace(
                '{"type":"toolCall","id":"call_1","name":"bash","arguments":{"command":"echo forge"}}',
                [
                  '{"type":"toolCall","id":"call_1","name":{"isEscaped":true},"arguments":{}}',
                  '{"type":"toolCall","id":7,"name":"bash","arguments":{}}',
                  '{"type":"toolCall","id":"call_bare","name":"ls"}',
                ].join(','),
              )
            : line,
        )
        .join('\n'),
    ),
  });

  assert.equal(code, 0);
  const calls = parseTranscript(transcript).filter(
    (event) => event.type === 'tool_call',
  );
  assert.deepEqual(
    calls.map((call) => [call.id, call.name, call.arguments]),
    [
      ['call_bare', 'ls', {}],
      ['call_2', 'bash', { command: 'cat missing.txt' }],
    ],
  );
});

test('given a recorded tool call whose arguments and result each exceed the cap, when the transcript is written, then the stored arguments and result text are cut at the cap and end in a truncation marker', async () => {
  const cap = 32 * 1024;
  const command = `echo ${'f'.repeat(40_000)}`;
  const output = `${'a'.repeat(50_000)}\n`;
  const { transcript } = await runWorker({
    output: outputFile(
      readFileSync(fixture('tool-calls.jsonl'), 'utf8')
        .replaceAll('"command":"echo forge"', `"command":"${command}"`)
        .replaceAll('"text":"forge\\n"', `"text":${JSON.stringify(output)}`),
    ),
  });

  const events = parseTranscript(transcript);
  const call = events.find(
    (event) => event.type === 'tool_call' && event.id === 'call_1',
  );
  const result = events.find(
    (event) => event.type === 'tool_result' && event.id === 'call_1',
  );
  const argumentsJson = JSON.stringify({ command });
  assert.deepEqual(call, {
    type: 'tool_call',
    id: 'call_1',
    name: 'bash',
    arguments: `${argumentsJson.slice(0, cap)}\n[truncated ${argumentsJson.length - cap} characters]`,
  });
  assert.deepEqual(result, {
    type: 'tool_result',
    id: 'call_1',
    isError: false,
    text: `${output.slice(0, cap)}\n[truncated ${output.length - cap} characters]`,
  });
});

test('given a recorded run whose subagent calls bash, when the transcript is written, then the child call and result carry its subagent scope and the parent subagent calls and their reports carry none', async () => {
  const { transcript } = await runWorker({
    output: fixture('subagents.jsonl'),
  });

  const toolEvents = parseTranscript(transcript).filter(
    (event) => event.type === 'tool_call' || event.type === 'tool_result',
  );
  assert.deepEqual(
    toolEvents.filter((event) => event.subagent === 'call_alpha'),
    [
      {
        type: 'tool_call',
        id: 'call_1',
        name: 'bash',
        arguments: { command: 'echo alpha' },
        subagent: 'call_alpha',
      },
      {
        type: 'tool_result',
        id: 'call_1',
        isError: false,
        text: 'alpha\n',
        subagent: 'call_alpha',
      },
    ],
  );
  assert.deepEqual(
    toolEvents
      .filter((event) => !Object.hasOwn(event, 'subagent'))
      .map((event) =>
        event.type === 'tool_call'
          ? [event.id, event.name, event.arguments]
          : [event.id, event.isError, event.text],
      ),
    [
      [
        'call_alpha',
        'subagent',
        { task: 'Run echo alpha and report what it printed.' },
      ],
      ['call_beta', 'subagent', { task: 'Say beta.' }],
      ['call_beta', false, 'Beta report: beta.'],
      ['call_alpha', false, 'Alpha report: echo alpha printed alpha.'],
    ],
  );
  assert.equal(toolEvents.length, 6);
});

test('given a recording where one subagent call returns an error and the parent finishes normally, when the run completes, then the run succeeds and its tokens and billed cost still count the failed child', async () => {
  const { code, run, lookups } = await runWorker({
    output: fixture('subagent-failure.jsonl'),
  });

  assert.equal(code, 0);
  assert.equal(run.status, 'success');
  assert.equal(run.error, null);
  assert.equal(run.inputTokens, 1400 + 1500 + 600 + 500);
  assert.equal(run.outputTokens, 30 + 10 + 20 + 6);
  assert.equal(run.costUsd, 0.5 + 0.25 + 0.125 + 0.03125);
  assert.equal(run.costStatus, 'billed');
  assert.deepEqual(lookups.map((lookup) => lookup.id).sort(), [
    'gen-child-alpha-1',
    'gen-child-beta-1',
    'gen-subagents-1',
    'gen-subagents-2',
  ]);
});

test('given a recording with two parallel subagent calls where one child generation lookup fails, when the run completes, then the run is recorded with the cost it could look up, marked unconfirmed', async () => {
  const billed = billedAt(BILLED_BY_ID);
  const {
    result: { code, run },
    journal,
  } = await journaled(() =>
    runWorker({
      output: fixture('subagents.jsonl'),
      generations: (id, attempt) =>
        id === 'gen-child-beta-1' ? { status: 401 } : billed(id, attempt),
    }),
  );

  assert.equal(code, 0);
  assert.equal(run.status, 'success');
  assert.equal(run.costUsd, 0.5 + 0.25 + 0.125 + 0.0625);
  assert.equal(run.costStatus, 'unconfirmed');
  assert.match(
    journal,
    /could not cost OpenRouter generation "gen-child-beta-1"/,
  );
});

test('given workers with and without a reasoning effort and a harness with operator extras, when each runs, then pi receives the json, no-session, offline, openrouter contract with the plain model, a thinking level only when declared, the subagent extension, the extras, and the prompt last', async () => {
  const output = fixture('success.jsonl');
  const contract = [
    '--mode',
    'json',
    '--no-session',
    '--offline',
    '--provider',
    'openrouter',
    '--model',
    'z-ai/glm-5',
  ];

  const withEffort = await runWorker({
    output,
    worker: { reasoningEffort: 'high' },
    harnessArgs: ['--no-skills'],
  });
  const withoutEffort = await runWorker({
    output,
    harnessArgs: ['--no-skills'],
  });

  assert.deepEqual(withEffort.pi.argv, [
    ...contract,
    '--thinking',
    'high',
    '-e',
    EXTENSION,
    '--no-skills',
    'refine the spec',
  ]);
  assert.deepEqual(withoutEffort.pi.argv, [
    ...contract,
    '-e',
    EXTENSION,
    '--no-skills',
    'refine the spec',
  ]);
});

test('given workers with and without a reasoning effort and a harness with operator extras, when each runs, then the subagent extension is handed the pi binary with the parent contract, provider, model and thinking level, never the extension, the extras or the prompt, and a sub-agent system prompt', async () => {
  const output = fixture('success.jsonl');

  const withEffort = await runWorker({
    output,
    worker: { reasoningEffort: 'high' },
    harnessArgs: ['--no-skills'],
  });
  const withoutEffort = await runWorker({
    output,
    harnessArgs: ['--no-skills'],
  });

  const childOf = (outcome: Outcome) =>
    JSON.parse(outcome.pi.subagentInvocation ?? 'null') as {
      argv: string[];
      systemPrompt: string;
    };
  const withEffortChild = childOf(withEffort);
  const withoutEffortChild = childOf(withoutEffort);
  const [binary] = withEffortChild.argv;
  const parentFlags = (outcome: Outcome) =>
    outcome.pi.argv.slice(0, outcome.pi.argv.indexOf('-e'));
  assert.match(binary ?? '', /fake-pi\.mjs$/);
  assert.deepEqual(withEffortChild.argv, [binary, ...parentFlags(withEffort)]);
  assert.deepEqual(
    withoutEffortChild.argv.slice(1),
    parentFlags(withoutEffort),
  );
  assert.ok(withEffortChild.argv.includes('--thinking'));
  assert.ok(!withoutEffortChild.argv.includes('--thinking'));
  assert.ok(!withEffortChild.argv.includes('-e'));
  assert.match(withEffortChild.systemPrompt, /sub-agent/);
  assert.match(withEffortChild.systemPrompt, /returned verbatim/);
  assert.match(withEffortChild.systemPrompt, /cannot spawn sub-agents/);
});

test('given any worker, when it runs, then pi works in a fresh per-run directory under the state directory, never the state directory itself', async () => {
  const { stateDir, run, pi } = await runWorker({
    output: fixture('success.jsonl'),
  });

  const state = realpathSync(stateDir);
  assert.notEqual(pi.cwd, state);
  assert.ok(pi.cwd.startsWith(state + sep));
  assert.match(pi.cwd, new RegExp(`${run.id}$`));
});

test('given recorded pi output ending in a provider error with no generation and pi exiting 0, when the worker runs, then the run is error with pi error message, the runner exits non-zero, and its zero cost is certain', async () => {
  const { code, run } = await runWorker({
    output: fixture('provider-error.jsonl'),
  });

  assert.equal(code, 1);
  assert.equal(run.status, 'error');
  assert.equal(run.error, '400 z-ai/glm-5 is not a valid model ID');
  assert.equal(run.costUsd, 0);
  assert.equal(run.costStatus, 'billed');
});

test('given recorded pi output where a failed attempt is retried and then succeeds, and an OpenRouter billing every generation, when the worker runs, then the run is success and its tokens and billed cost include the failed attempt', async () => {
  const { code, run } = await runWorker({ output: fixture('retry.jsonl') });

  assert.equal(code, 0);
  assert.equal(run.status, 'success');
  assert.equal(run.inputTokens, 900 + 900);
  assert.equal(run.outputTokens, 3 + 8);
  assert.equal(run.costUsd, 0.002 + 0.004);
  assert.equal(run.costStatus, 'billed');
});

test('given pi failing pre-flight with its reason on stderr and exit 1, when the worker runs, then the run is error carrying that reason and stderr still reaches the journal', async () => {
  const { result: outcome, journal } = await journaled(() =>
    runWorker({
      output: fixture('preflight.jsonl'),
      stderr: fixture('preflight.stderr'),
      exit: 1,
    }),
  );

  assert.equal(outcome.code, 1);
  assert.equal(outcome.run.status, 'error');
  assert.match(outcome.run.error ?? '', /No API key found for openrouter\./);
  assert.equal(outcome.run.sessionId, sessionIdOf(fixture('preflight.jsonl')));
  assert.match(journal, /No API key found for openrouter\./);
});

test('given pi output that is cut off before a final agent_end, that ends on an agent_end that will retry, or that is cut off in a run pi continued after a final agent_end, when the worker runs, then the run is error', async () => {
  for (const output of [
    cutBefore('success.jsonl', 'agent_end'),
    cutBefore('retry.jsonl', 'auto_retry_start'),
    outputFile(
      `${readFileSync(fixture('success.jsonl'), 'utf8').trimEnd()}\n{"type":"agent_start"}\n{"type":"turn_start"}\n`,
    ),
  ]) {
    const { code, run } = await runWorker({ output });
    assert.equal(run.status, 'error');
    assert.equal(code, 1);
    assert.match(run.error ?? '', /agent_end/);
  }
});

test('given pi writing output that is not json and staying alive, when the worker runs, then the run is error naming the bad output, keeps the session id, and pi is stopped before the runner returns', async () => {
  const header = readFileSync(fixture('success.jsonl'), 'utf8').split('\n')[0];
  const { code, run, pi } = await runWorker({
    output: outputFile(`${header}\npi: something went wrong\n`),
    lingerMs: 10_000,
  });

  assert.equal(code, 1);
  assert.equal(run.status, 'error');
  assert.match(
    run.error ?? '',
    /pi emitted non-JSON output: pi: something went wrong/,
  );
  assert.equal(run.sessionId, sessionIdOf(fixture('success.jsonl')));
  assert.equal(isAlive(pi.pid), false);
});

test('given a successful recorded run and an OpenRouter that keeps failing one generation lookup, with a rejected key, a server error, an unusable body, a not found that never clears, a connection that keeps dropping, or no answer at all, when the worker runs, then the run stays success with the cost it could look up, cost status unconfirmed, and the journal names the generation and why without the key', async () => {
  const failures: [ReturnType<GenerationStats>, RegExp][] = [
    [{ status: 401, body: { error: { code: 401 } } }, /HTTP 401/],
    [{ status: 500, body: { error: { code: 500 } } }, /HTTP 500/],
    [{ status: 200, body: { data: { id: 'gen-success-2' } } }, /total_cost/],
    [{ status: 200, body: 'not json' }, /SyntaxError/],
    [{ status: 404, body: { error: { code: 404 } } }, /HTTP 404/],
    ['hang', /timeout|abort/i],
    ['reset', /TypeError UND_ERR_SOCKET/],
  ];

  const { result: outcomes, journal } = await journaled(() =>
    Promise.all(
      failures.map(([failure]) =>
        runWorker({
          output: fixture('success.jsonl'),
          generations: (id, attempt) =>
            id === 'gen-success-2'
              ? failure
              : billedAt(BILLED_BY_ID)(id, attempt),
        }),
      ),
    ),
  );

  for (const { code, run } of outcomes) {
    assert.equal(code, 0);
    assert.equal(run.status, 'success');
    assert.equal(run.error, null);
    assert.equal(run.costUsd, 0.0125);
    assert.equal(run.costStatus, 'unconfirmed');
  }
  const reasons = journal
    .split('\n')
    .filter((line) => line.includes('"gen-success-2"'));
  for (const [, reason] of failures) {
    assert.ok(
      reasons.some((line) => reason.test(line)),
      `journal names ${reason}`,
    );
  }
  assert.doesNotMatch(journal, /gen-success-1/);
  assert.doesNotMatch(journal, new RegExp(OPENROUTER_KEY));
});

test('given an OpenRouter that answers a generation lookup with not found while its stats lag, a rate limit, a server error, or a dropped connection at first and then its billed cost, when the worker runs, then the run cost includes that generation and is billed', async () => {
  const transients: ReturnType<GenerationStats>[] = [
    { status: 404, body: { error: { code: 404 } } },
    { status: 429, body: { error: { code: 429 } } },
    { status: 503, body: { error: { code: 503 } } },
    'reset',
  ];

  const outcomes = await Promise.all(
    transients.map((transient) =>
      runWorker({
        output: fixture('success.jsonl'),
        generations: (id, attempt) =>
          id === 'gen-success-2' && attempt < 3
            ? transient
            : billedAt(BILLED_BY_ID)(id, attempt),
      }),
    ),
  );

  for (const { run, lookups } of outcomes) {
    assert.equal(run.status, 'success');
    assert.equal(run.costUsd, 0.0125 + 0.0375);
    assert.equal(run.costStatus, 'billed');
    assert.equal(
      lookups.filter((lookup) => lookup.id === 'gen-success-2').length,
      3,
    );
  }
});

test('given a successful recorded run and an OpenRouter base URL that is not a valid URL, when the worker runs, then the run stays success and exits zero with cost status unconfirmed, and the journal names each generation it could not cost', async () => {
  const {
    result: { code, run },
    journal,
  } = await journaled(() =>
    runWorker({
      output: fixture('success.jsonl'),
      openRouterBaseUrl: 'openrouter.ai/api/v1',
    }),
  );

  assert.match(journal, /could not cost OpenRouter generation "gen-success-1"/);
  assert.match(journal, /could not cost OpenRouter generation "gen-success-2"/);
  assert.equal(code, 0);
  assert.equal(run.status, 'success');
  assert.equal(run.error, null);
  assert.equal(run.costUsd, 0);
  assert.equal(run.costStatus, 'unconfirmed');
});

test('given a long run with many generations, one of them reported twice, when the worker runs, then each generation is billed once and at most four lookups are in flight at a time', async () => {
  const ids = Array.from({ length: 12 }, (_, index) => `gen-long-${index}`);
  const costs = Object.fromEntries(ids.map((id) => [id, 0.5]));

  const { run, lookups } = await runWorker({
    output: withGenerations('success.jsonl', [...ids, 'gen-long-0']),
    generations: (id, attempt) => {
      const reply = billedAt({ ...BILLED_BY_ID, ...costs })(id, attempt);
      return typeof reply === 'string' ? reply : { ...reply, delayMs: 20 };
    },
  });

  assert.equal(run.status, 'success');
  assert.equal(run.costStatus, 'billed');
  assert.equal(run.costUsd, 0.0125 + 0.0375 + 12 * 0.5);
  assert.equal(lookups.length, 14);
  assert.ok(Math.max(...lookups.map((lookup) => lookup.inFlight)) <= 4);
});

test('given recorded pi output where an assistant response used tokens but carries no generation id, when the worker runs, then the run stays success with the cost of the generations it could name, marked unconfirmed', async () => {
  const output = outputFile(
    readFileSync(fixture('success.jsonl'), 'utf8')
      .split('\n')
      .map((line) =>
        line.includes('"type":"message_end"')
          ? line.replace(',"responseId":"gen-success-2"', '')
          : line,
      )
      .join('\n'),
  );

  const { run, lookups } = await runWorker({ output });

  assert.equal(run.status, 'success');
  assert.deepEqual(
    lookups.map((lookup) => lookup.id),
    ['gen-success-1'],
  );
  assert.equal(run.costUsd, 0.0125);
  assert.equal(run.costStatus, 'unconfirmed');
});

test('given an OpenRouter key that is not a valid header value, when the worker runs, then the run stays success with cost status unconfirmed and the key never reaches the journal', async () => {
  const { result: outcome, journal } = await journaled(() =>
    runWorker({
      output: fixture('success.jsonl'),
      openRouterKey: 'sk-or-secret\nleak',
    }),
  );

  assert.equal(outcome.run.status, 'success');
  assert.equal(outcome.run.costStatus, 'unconfirmed');
  assert.match(journal, /could not cost OpenRouter generation "gen-success-1"/);
  assert.doesNotMatch(journal, /sk-or-secret/);
});

test('given a runner with no subagent extension to load, when a pi worker runs, then the runner refuses before starting pi', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'forge-main-'));
  const configPath = join(stateDir, 'runtime.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      harnesses: { pi: { command: join(stateDir, 'no-pi') } },
      workers: {
        refiner: { harness: 'pi', model: 'z-ai/glm-5', prompt: 'refine' },
      },
    }),
  );

  await assert.rejects(
    main(['refiner'], {
      FORGE_RUNTIME_CONFIG: configPath,
      FORGE_STATE_DIR: stateDir,
    }),
    /FORGE_PI_SUBAGENT_EXTENSION is not set/,
  );
  assert.deepEqual(readdirSync(stateDir), ['runtime.json']);
});
