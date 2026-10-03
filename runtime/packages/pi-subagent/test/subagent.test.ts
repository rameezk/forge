import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import subagentExtension, {
  SUBAGENT_INVOCATION_ENV,
  type SubagentDetails,
  type SubagentInvocation,
  type SubagentTool,
  type SubagentUpdate,
  type ToolResultHandler,
} from '../src/index.ts';

const fixture = (name: string): string =>
  join(import.meta.dirname, 'fixtures', name);

const CHILD_OUTPUT = fixture('child.jsonl');

const TASK = 'Run echo alpha and report what it printed.';

interface ChildStart {
  argv: string[];
  cwd: string;
  pid: number;
  agentDir?: string;
  path?: string;
}

type ChildLog =
  | { started: ChildStart }
  | { ended: number }
  | { tool: number }
  | { ignoredTerm: number };

interface FakeChild {
  output?: string;
  exit?: number;
  stderr?: string;
  lingerMs?: number;
  onTerm?: 'clean-up' | 'ignore';
}

const TERM_HANDLERS = {
  'clean-up': `const tool = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
log({ tool: tool.pid });
process.on('SIGTERM', () => {
  process.kill(-tool.pid, 'SIGKILL');
  process.exit(143);
});`,
  ignore: `process.on('SIGTERM', () => log({ ignoredTerm: process.pid }));`,
};

const fakeChildPi = (
  child: FakeChild = {},
): { path: string; log: () => ChildLog[]; starts: () => ChildStart[] } => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-subagent-'));
  const log = join(dir, 'children.jsonl');
  const path = join(dir, 'fake-pi.mjs');
  writeFileSync(
    path,
    `#!${process.execPath}
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
const log = (entry) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + '\\n');
log({ started: { argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid, agentDir: process.env.PI_CODING_AGENT_DIR, path: process.env.PATH } });
${child.onTerm === undefined ? '' : TERM_HANDLERS[child.onTerm]}
process.stdout.write(readFileSync(${JSON.stringify(child.output ?? CHILD_OUTPUT)}, 'utf8'));
process.stderr.write(${JSON.stringify(child.stderr ?? '')});
setTimeout(() => {
  log({ ended: process.pid });
  process.exit(${child.exit ?? 0});
}, ${child.lingerMs ?? 0});
`,
  );
  chmodSync(path, 0o755);
  const entries = (): ChildLog[] =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as ChildLog);
  return {
    path,
    log: entries,
    starts: () =>
      entries().flatMap((entry) => ('started' in entry ? [entry.started] : [])),
  };
};

interface PiToolResult {
  content: { type: 'text'; text: string }[];
  details: SubagentDetails | Record<string, never>;
  isError: boolean;
  updates: SubagentUpdate[];
}

interface LoadedExtension {
  tool: SubagentTool;
  call(
    params: { task: string; cwd?: string },
    options: {
      cwd: string;
      signal?: AbortSignal;
      toolCallId?: string;
      onUpdate?: (update: SubagentUpdate) => void;
    },
  ): Promise<PiToolResult>;
}

const loadExtension = (invocation: SubagentInvocation): LoadedExtension => {
  process.env[SUBAGENT_INVOCATION_ENV] = JSON.stringify(invocation);
  const tools: SubagentTool[] = [];
  const toolResultHandlers: ToolResultHandler[] = [];
  subagentExtension({
    registerTool: (tool) => tools.push(tool),
    on: (_event, handler) => toolResultHandlers.push(handler),
  });
  assert.equal(tools.length, 1);
  const tool = tools[0] as SubagentTool;
  return {
    tool,
    async call(params, { cwd, signal, toolCallId = 'call_alpha', onUpdate }) {
      const updates: SubagentUpdate[] = [];
      let result: Omit<PiToolResult, 'updates'>;
      try {
        const returned = await tool.execute(
          toolCallId,
          params,
          signal,
          (partial) => {
            updates.push(partial.details);
            onUpdate?.(partial.details);
          },
          { cwd },
        );
        result = { ...returned, isError: false };
      } catch (error) {
        result = {
          content: [{ type: 'text', text: (error as Error).message }],
          details: {},
          isError: true,
        };
      }
      for (const handler of toolResultHandlers) {
        const patch = await handler({
          type: 'tool_result',
          toolName: tool.name,
          toolCallId,
          input: params,
          ...result,
        });
        result = { ...result, ...patch };
      }
      return { ...result, updates };
    },
  };
};

const loadTool = (invocation: SubagentInvocation): SubagentTool =>
  loadExtension(invocation).tool;

const REQUEST_RECORD_FD = openSync(
  join(mkdtempSync(join(tmpdir(), 'forge-request-record-')), 'requests.jsonl'),
  'a',
);

const childInvocation = (binary: string): SubagentInvocation => ({
  argv: [
    binary,
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
  ],
  systemPrompt: 'You are a sub-agent.',
  requestRecordFd: REQUEST_RECORD_FD,
});

const runDir = (): string => mkdtempSync(join(tmpdir(), 'forge-run-'));

test('given the extension loaded by pi, when it registers, then it offers one subagent tool taking a single task and an optional working directory, never forced sequential, that tells the model to issue several calls in one message to run sub-agents in parallel', () => {
  const tool = loadTool(childInvocation('/bin/pi'));

  assert.equal(tool.name, 'subagent');
  assert.deepEqual(Object.keys(tool.parameters.properties), ['task', 'cwd']);
  assert.deepEqual(tool.parameters.required, ['task']);
  assert.notEqual(
    (tool as { executionMode?: string }).executionMode,
    'sequential',
  );
  assert.match(tool.description, /several subagent calls in one message/);
  assert.match(tool.description, /parallel/);
});

test('given a fake child pi replaying a successful recorded child run, when the tool executes a task, then the result is the child final assistant message, the details carry every child response id with its usage, and every child event is forwarded as an update', async () => {
  const child = fakeChildPi();
  const extension = loadExtension(childInvocation(child.path));

  const result = await extension.call({ task: TASK }, { cwd: runDir() });

  assert.equal(result.isError, false);
  assert.deepEqual(result.content, [
    { type: 'text', text: 'Alpha report: echo alpha printed alpha.' },
  ]);
  assert.deepEqual(result.details.responses, [
    {
      responseId: 'gen-child-alpha-1',
      usage: { input: 600, output: 20, cacheRead: 0, cacheWrite: 0 },
    },
    {
      responseId: 'gen-child-alpha-2',
      usage: { input: 100, output: 12, cacheRead: 600, cacheWrite: 0 },
    },
  ]);
  assert.deepEqual(
    result.updates.map((update) => update.event),
    readFileSync(CHILD_OUTPUT, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as unknown),
  );
});

test('given a child invocation from the adapter, when the tool executes a task, then the child is that binary run with exactly that invocation, the appended sub-agent system prompt and the task, never the extension, in the parent working directory', async () => {
  const child = fakeChildPi();
  const invocation = childInvocation(child.path);
  const cwd = runDir();

  await loadExtension(invocation).call({ task: TASK }, { cwd });

  const [call] = child.starts() as [ChildStart];
  assert.deepEqual(call.argv, [
    ...invocation.argv.slice(1),
    '--append-system-prompt',
    invocation.systemPrompt,
    `Task: ${TASK}`,
  ]);
  assert.ok(!call.argv.includes('-e'));
  assert.equal(call.cwd, realpathSync(cwd));
});

test('given a parent pi pointed at a read-only agent dir, with a path that leads with its repository\'s devShell, when the tool executes a task, then the child inherits that agent dir and the same path', async () => {
  const child = fakeChildPi();
  const agentDir = '/nix/store/00000000000000000000000000000000-pi-agent-dir';
  const path = `/nix/store/00000000000000000000000000000000-devshell-stub/bin:${process.env.PATH ?? ''}`;
  const previous = { agentDir: process.env.PI_CODING_AGENT_DIR, path: process.env.PATH };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PATH = path;
  try {
    await loadExtension(childInvocation(child.path)).call(
      { task: TASK },
      { cwd: runDir() },
    );
  } finally {
    for (const [name, value] of [
      ['PATH', previous.path],
      ['PI_CODING_AGENT_DIR', previous.agentDir],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }

  const [call] = child.starts() as [ChildStart];
  assert.equal(call.agentDir, agentDir);
  assert.equal(call.path, path);
});

test('given no usable child invocation in the environment, when pi loads the extension, then it refuses to load naming the variable rather than guessing the pi binary', () => {
  for (const value of [
    undefined,
    'pi --mode json',
    '{"argv":[],"systemPrompt":"x","requestRecordFd":4}',
    '{"argv":["pi"],"requestRecordFd":4}',
    '{"argv":["pi"],"systemPrompt":"x"}',
    '{"argv":["pi"],"systemPrompt":"x","requestRecordFd":2}',
  ]) {
    if (value === undefined) {
      delete process.env[SUBAGENT_INVOCATION_ENV];
    } else {
      process.env[SUBAGENT_INVOCATION_ENV] = value;
    }

    assert.throws(
      () =>
        subagentExtension({
          registerTool: () => undefined,
          on: () => undefined,
        }),
      new RegExp(SUBAGENT_INVOCATION_ENV),
    );
  }
});

test('given a child invocation whose pi binary cannot be started, when the tool executes, then the call fails as a tool error naming the failure instead of taking pi down', async () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'forge-subagent-')), 'no-pi');

  const result = await loadExtension(childInvocation(missing)).call(
    { task: TASK },
    { cwd: runDir() },
  );

  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /ENOENT/);
  assert.deepEqual((result.details as SubagentDetails).responses, []);
});

test('given a child that reports a provider error in-stream and exits 0, when the tool executes, then pi sees a tool error carrying the provider failure, and the details still carry the usage and response id the child produced', async () => {
  const child = fakeChildPi({ output: fixture('child-provider-error.jsonl') });

  const result = await loadExtension(childInvocation(child.path)).call(
    { task: TASK },
    { cwd: runDir() },
  );

  assert.equal(result.isError, true);
  assert.match(
    result.content.map((part) => part.text).join(''),
    /400: \{"code":400,"message":"z-ai\/glm-5 is not a valid model ID"\}/,
  );
  assert.deepEqual((result.details as SubagentDetails).responses, [
    {
      responseId: 'gen-child-alpha-1',
      usage: { input: 600, output: 20, cacheRead: 0, cacheWrite: 0 },
    },
    { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  ]);
});

test('given a child that exits non-zero with its reason on stderr, when the tool executes, then pi sees a tool error carrying the exit and that reason, and the details still carry the usage and response ids the child produced', async () => {
  const child = fakeChildPi({
    exit: 3,
    stderr: 'No API key found for openrouter.\n',
  });

  const result = await loadExtension(childInvocation(child.path)).call(
    { task: TASK },
    { cwd: runDir() },
  );

  assert.equal(result.isError, true);
  assert.match(
    result.content[0]?.text ?? '',
    /exited with code 3: No API key found for openrouter\./,
  );
  assert.deepEqual(
    (result.details as SubagentDetails).responses.map(
      (response) => response.responseId,
    ),
    ['gen-child-alpha-1', 'gen-child-alpha-2'],
  );
});

const isZombie = (pid: number): boolean => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
  } catch {
    return false;
  }
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return !isZombie(pid);
};

const abortOnceDone = (
  abort: AbortController,
): ((update: SubagentUpdate) => void) => {
  return ({ event }) => {
    if ((event as { type?: string }).type === 'agent_end') {
      abort.abort();
    }
  };
};

test('given a call that is aborted while its child is still running a tool, when the tool executes, then pi sees a tool error saying it was aborted, the details still carry the usage and response ids the child produced, and the child is asked to stop so it takes its running tools down with it', async () => {
  const child = fakeChildPi({ lingerMs: 60_000, onTerm: 'clean-up' });
  const abort = new AbortController();

  const result = await loadExtension(childInvocation(child.path)).call(
    { task: TASK },
    { cwd: runDir(), signal: abort.signal, onUpdate: abortOnceDone(abort) },
  );

  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /aborted/);
  assert.deepEqual(
    (result.details as SubagentDetails).responses.map(
      (response) => response.responseId,
    ),
    ['gen-child-alpha-1', 'gen-child-alpha-2'],
  );
  const [start] = child.starts() as [ChildStart];
  assert.equal(isAlive(start.pid), false);
  const tools = child
    .log()
    .flatMap((entry) => ('tool' in entry ? [entry.tool] : []));
  assert.equal(tools.length, 1);
  assert.equal(isAlive(tools[0] as number), false);
});

test('given an aborted child that ignores the request to stop, when the tool executes, then it is killed anyway', async () => {
  const child = fakeChildPi({ lingerMs: 60_000, onTerm: 'ignore' });
  const abort = new AbortController();

  const result = await loadExtension(childInvocation(child.path)).call(
    { task: TASK },
    { cwd: runDir(), signal: abort.signal, onUpdate: abortOnceDone(abort) },
  );

  assert.equal(result.isError, true);
  assert.ok(child.log().some((entry) => 'ignoredTerm' in entry));
  const [start] = child.starts() as [ChildStart];
  assert.equal(isAlive(start.pid), false);
});

test('given a call that is already aborted, when the tool executes, then pi sees a tool error saying it was aborted and no child is started', async () => {
  const child = fakeChildPi();

  const result = await loadExtension(childInvocation(child.path)).call(
    { task: TASK },
    { cwd: runDir(), signal: AbortSignal.abort() },
  );

  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /aborted/);
  assert.throws(() => child.starts(), /ENOENT/);
});

test('given a working directory that resolves outside the parent run working directory, by climbing out, by an absolute path elsewhere, by a sibling sharing its prefix, or through a symlink, or that is not a directory in it, when the tool executes, then pi sees a tool error naming the directory and no child is started', async () => {
  const cwd = runDir();
  const outside = mkdtempSync(join(tmpdir(), 'forge-elsewhere-'));
  mkdirSync(`${cwd}-sibling`);
  symlinkSync(outside, join(cwd, 'escape'));
  mkdirSync(join(cwd, 'inside'));
  writeFileSync(join(cwd, 'notes.txt'), 'not a directory');

  for (const dir of [
    '..',
    'inside/../..',
    outside,
    `${cwd}-sibling`,
    `../${basename(cwd)}-sibling`,
    'escape',
    'missing',
    'notes.txt',
  ]) {
    const child = fakeChildPi();

    const result = await loadExtension(childInvocation(child.path)).call(
      { task: TASK, cwd: dir },
      { cwd },
    );

    assert.equal(result.isError, true, dir);
    assert.match(result.content[0]?.text ?? '', /working directory/, dir);
    assert.ok(
      (result.content[0]?.text ?? '').includes(JSON.stringify(dir)),
      dir,
    );
    assert.throws(() => child.starts(), /ENOENT/, dir);
  }
});

test('given a working directory inside the parent run working directory, relative, absolute, or the run directory itself, when the tool executes, then the child runs in that directory', async () => {
  const cwd = runDir();
  mkdirSync(join(cwd, 'repo', 'pkg'), { recursive: true });

  for (const [dir, expected] of [
    ['repo/pkg', join(cwd, 'repo', 'pkg')],
    [join(cwd, 'repo'), join(cwd, 'repo')],
    ['repo/../repo/pkg/..', join(cwd, 'repo')],
    ['.', cwd],
  ] as const) {
    const child = fakeChildPi();

    const result = await loadExtension(childInvocation(child.path)).call(
      { task: TASK, cwd: dir },
      { cwd },
    );

    assert.equal(result.isError, false, dir);
    const [start] = child.starts() as [ChildStart];
    assert.equal(start.cwd, realpathSync(expected), dir);
  }
});

test('given six calls issued at once, when they execute, then no more than four children run at any moment, and all six complete', async () => {
  const child = fakeChildPi({ lingerMs: 300 });
  const extension = loadExtension(childInvocation(child.path));
  const cwd = runDir();

  const results = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      extension.call({ task: TASK }, { cwd, toolCallId: `call_${index}` }),
    ),
  );

  assert.deepEqual(
    results.map((result) => result.isError),
    Array.from({ length: 6 }, () => false),
  );
  let running = 0;
  let peak = 0;
  for (const entry of child.log()) {
    running += 'started' in entry ? 1 : 'ended' in entry ? -1 : 0;
    peak = Math.max(peak, running);
  }
  assert.equal(peak, 4);
  assert.equal(child.starts().length, 6);
});

test('given four running children and a fifth call queued behind them, when the queued call is aborted, then it returns an aborted tool error at once without starting a child', async () => {
  const child = fakeChildPi({ lingerMs: 60_000 });
  const extension = loadExtension(childInvocation(child.path));
  const cwd = runDir();
  const running = new AbortController();
  let resolveAllRunning = (): void => undefined;
  const allRunning = new Promise<void>((resolve) => {
    resolveAllRunning = resolve;
  });
  let done = 0;
  const onUpdate = ({ event }: SubagentUpdate): void => {
    if ((event as { type?: string }).type === 'agent_end' && ++done === 4) {
      resolveAllRunning();
    }
  };
  const runningCalls = Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      extension.call(
        { task: TASK },
        { cwd, signal: running.signal, toolCallId: `call_${index}`, onUpdate },
      ),
    ),
  );
  await allRunning;
  const queued = new AbortController();

  const pending = extension.call(
    { task: TASK },
    { cwd, signal: queued.signal, toolCallId: 'call_queued' },
  );
  queued.abort();
  const result = await Promise.race([
    pending,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
  ]);
  running.abort();
  await runningCalls;

  assert.ok(result !== null, 'the aborted queued call is still waiting');
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /aborted/);
  assert.equal(child.starts().length, 4);
});

test('given a child that exits 0 with its stream cut off before a final agent_end, ending on an agent_end that will retry, or cut off in a run it continued after a final agent_end, when the tool executes, then pi sees a tool error saying the stream ended early, and the details still carry the usage and response ids the child produced', async () => {
  const lines = readFileSync(CHILD_OUTPUT, 'utf8').trimEnd().split('\n');
  const end = lines.findIndex((line) => line.includes('"type":"agent_end"'));
  const outputs = [
    lines.slice(0, end),
    [
      ...lines.slice(0, end),
      (lines[end] as string).replace('"willRetry":false', '"willRetry":true'),
    ],
    [...lines, '{"type":"agent_start"}', '{"type":"turn_start"}'],
  ];

  for (const output of outputs) {
    const path = join(
      mkdtempSync(join(tmpdir(), 'forge-output-')),
      'out.jsonl',
    );
    writeFileSync(path, `${output.join('\n')}\n`);
    const child = fakeChildPi({ output: path });

    const result = await loadExtension(childInvocation(child.path)).call(
      { task: TASK },
      { cwd: runDir() },
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /without a final agent_end/);
    assert.deepEqual(
      (result.details as SubagentDetails).responses.map(
        (response) => response.responseId,
      ),
      ['gen-child-alpha-1', 'gen-child-alpha-2'],
    );
  }
});
