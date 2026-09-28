import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import subagentExtension, {
  SUBAGENT_INVOCATION_ENV,
  type SubagentInvocation,
  type SubagentTool,
  type SubagentUpdate,
} from '../src/index.ts';

const CHILD_OUTPUT = join(import.meta.dirname, 'fixtures', 'child.jsonl');

const TASK = 'Run echo alpha and report what it printed.';

interface ChildCall {
  argv: string[];
  cwd: string;
}

const fakeChildPi = (
  output: string,
): { path: string; calls: () => ChildCall } => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-subagent-'));
  const record = join(dir, 'child-call.json');
  const path = join(dir, 'fake-pi.mjs');
  writeFileSync(
    path,
    `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
process.stdout.write(readFileSync(${JSON.stringify(output)}, 'utf8'));
`,
  );
  chmodSync(path, 0o755);
  return {
    path,
    calls: () => JSON.parse(readFileSync(record, 'utf8')) as ChildCall,
  };
};

const loadTool = (invocation: SubagentInvocation): SubagentTool => {
  process.env[SUBAGENT_INVOCATION_ENV] = JSON.stringify(invocation);
  const tools: SubagentTool[] = [];
  subagentExtension({ registerTool: (tool) => tools.push(tool) });
  assert.equal(tools.length, 1);
  return tools[0] as SubagentTool;
};

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
});

const execute = async (tool: SubagentTool, cwd: string) => {
  const updates: SubagentUpdate[] = [];
  const result = await tool.execute(
    'call_alpha',
    { task: TASK },
    undefined,
    (partial) => updates.push(partial.details),
    { cwd },
  );
  return { result, updates };
};

test('given the extension loaded by pi, when it registers, then it offers one subagent tool taking a single task, never forced sequential, that tells the model to issue several calls in one message to run sub-agents in parallel', () => {
  const tool = loadTool(childInvocation('/bin/pi'));

  assert.equal(tool.name, 'subagent');
  assert.deepEqual(Object.keys(tool.parameters.properties), ['task']);
  assert.deepEqual(tool.parameters.required, ['task']);
  assert.notEqual(
    (tool as { executionMode?: string }).executionMode,
    'sequential',
  );
  assert.match(tool.description, /several subagent calls in one message/);
  assert.match(tool.description, /parallel/);
});

test('given a fake child pi replaying a successful recorded child run, when the tool executes a task, then the result is the child final assistant message, the details carry every child response id with its usage, and every child event is forwarded as an update', async () => {
  const child = fakeChildPi(CHILD_OUTPUT);
  const tool = loadTool(childInvocation(child.path));

  const { result, updates } = await execute(
    tool,
    mkdtempSync(join(tmpdir(), 'forge-run-')),
  );

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
    updates.map((update) => update.event),
    readFileSync(CHILD_OUTPUT, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as unknown),
  );
});

test('given a child invocation from the adapter, when the tool executes a task, then the child is that binary run with exactly that invocation, the appended sub-agent system prompt and the task, never the extension, in the parent working directory', async () => {
  const child = fakeChildPi(CHILD_OUTPUT);
  const invocation = childInvocation(child.path);
  const tool = loadTool(invocation);
  const cwd = mkdtempSync(join(tmpdir(), 'forge-run-'));

  await execute(tool, cwd);

  const call = child.calls();
  assert.deepEqual(call.argv, [
    ...invocation.argv.slice(1),
    '--append-system-prompt',
    invocation.systemPrompt,
    `Task: ${TASK}`,
  ]);
  assert.ok(!call.argv.includes('-e'));
  assert.equal(call.cwd, realpathSync(cwd));
});

test('given no usable child invocation in the environment, when pi loads the extension, then it refuses to load naming the variable rather than guessing the pi binary', () => {
  for (const value of [
    undefined,
    'pi --mode json',
    '{"argv":[],"systemPrompt":"x"}',
    '{"argv":["pi"]}',
  ]) {
    if (value === undefined) {
      delete process.env[SUBAGENT_INVOCATION_ENV];
    } else {
      process.env[SUBAGENT_INVOCATION_ENV] = value;
    }

    assert.throws(
      () => subagentExtension({ registerTool: () => undefined }),
      new RegExp(SUBAGENT_INVOCATION_ENV),
    );
  }
});
