import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const [adapter, claude, fixtures] = process.argv.slice(2);
const { claudeCodeArgs, claudeCodeEnv } = await import(adapter);
const { UNATTENDED_INSTRUCTION, NARRATION_INSTRUCTION } = await import(
  join(dirname(adapter), 'harness.ts')
);
const {
  default: { 'claude-code': REASONING_EFFORTS },
} = await import(join(dirname(adapter), 'reasoning-efforts.json'), {
  with: { type: 'json' },
});
const {
  serveMessages,
  subagentsScenario,
  retryScenario,
  compactionScenario,
  subagentCompactionScenario,
  manySubagentsScenario,
  RAISED_LIMIT_FILES,
  SUBAGENT_LIMIT_REFUSAL,
  isSubagentRequest,
  toolNames,
  CLAUDE_TOKEN,
} = await import(join(fixtures, 'fake-anthropic.ts'));
const { anthropicReply, anthropicSse, anthropicUsage } = await import(
  join(fixtures, 'fake-provider.ts')
);

const MARKER = 'contract check marker for the repository instructions';
const USAGE = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 };
const PER_PROCESS_INIT_FIELDS = ['messaging_socket_path', 'session_id', 'uuid'];

const ATTRIBUTION_PATTERNS = [/Generated with \[?Claude Code/i, /Co-Authored-By/i];

const attributionMentions = (request) => {
  const wire = JSON.stringify(request ?? {});
  return ATTRIBUTION_PATTERNS.filter((pattern) => pattern.test(wire)).map(String);
};

const expectNoAttribution = (label, request) => {
  const mentions = attributionMentions(request);
  expect(
    mentions.length === 0,
    `${label}: the request still carries the attribution instruction (${mentions.join(', ')})`,
  );
};

const requests = [];
const server = await serveMessages((_call, res) => {
  anthropicSse(
    res,
    anthropicReply(
      'msg_contract',
      { text: 'contract ok' },
      anthropicUsage(USAGE.input, USAGE.cacheRead, USAGE.cacheWrite, USAGE.output),
    ),
  );
}, requests);
const { port } = server.address();

const scratch = mkdtempSync(join(tmpdir(), 'claude-contract-'));
const home = join(scratch, 'home');
mkdirSync(home);
const workDir = join(scratch, 'work');
mkdirSync(workDir);
writeFileSync(join(workDir, 'AGENTS.md'), `${MARKER}\n`);

const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

const runClaude = async (
  label,
  reasoningEffort,
  configDir,
  { work = workDir, prompt = 'contract check', endpoint = port, args: extraArgs = [] } = {},
) => {
  const bodiesDir = mkdtempSync(join(scratch, 'bodies-'));
  mkdirSync(configDir, { recursive: true });
  const args = claudeCodeArgs(
    {
      provider: 'anthropic',
      model: 'claude-opus-4-5',
      prompt,
      workDir: work,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    },
    { maxCostUsd: 1, extraArgs },
  );
  const child = spawn(claude, args, {
    cwd: work,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      HOME: home,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${endpoint}`,
      ...claudeCodeEnv({ CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN }, configDir, bodiesDir),
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => (stdout += data));
  child.stderr.on('data', (data) => (stderr += data));
  const [code] = await once(child, 'close');
  return { label, code, stdout, stderr, bodiesDir };
};

const events = (run) =>
  run.stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        failures.push(`${run.label}: stdout line is not stream-json: ${line.slice(0, 120)}`);
        return {};
      }
    });

const check = (run, requestsBefore, reasoningEffort) => {
  const stream = events(run);
  expect(
    run.code === 0,
    `${run.label}: claude exited ${run.code} on forge's flags: ${run.stderr.slice(0, 400)}`,
  );
  const init = stream.find((event) => event.type === 'system' && event.subtype === 'init');
  expect(init !== undefined, `${run.label}: no system init event on stdout`);
  const result = stream.find((event) => event.type === 'result');
  expect(
    result?.subtype === 'success' && result?.is_error === false,
    `${run.label}: no successful result event on stdout`,
  );
  expect(
    stream.some((event) => event.type === 'assistant'),
    `${run.label}: no assistant event on stdout`,
  );

  const index = (() => {
    try {
      return readFileSync(join(run.bodiesDir, 'index.jsonl'), 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  })();
  const entry = index.find((line) => line.message_id === 'msg_contract');
  expect(entry !== undefined, `${run.label}: raw API bodies index has no entry for the message`);
  if (entry !== undefined) {
    const response = (() => {
      try {
        return JSON.parse(
          readFileSync(join(run.bodiesDir, entry.response_file.split('/').pop()), 'utf8'),
        );
      } catch {
        return null;
      }
    })();
    expect(response !== null, `${run.label}: raw API response body is unreadable`);
    const usage = response?.usage ?? {};
    expect(
      usage.input_tokens === USAGE.input &&
        usage.output_tokens === USAGE.output &&
        (usage.cache_read_input_tokens ?? 0) === USAGE.cacheRead &&
        (usage.cache_creation_input_tokens ?? 0) === USAGE.cacheWrite,
      `${run.label}: raw API response body usage ${JSON.stringify(usage)} does not carry the served token counts`,
    );
    expect(
      typeof entry.request_id === 'string' && entry.request_id.startsWith('req_'),
      `${run.label}: raw API bodies index has no request id`,
    );
  }

  const sent = requests.slice(requestsBefore);
  const mainRequest = sent.find((request) => request.model === 'claude-opus-4-5');
  expect(mainRequest !== undefined, `${run.label}: no request reached the fake endpoint for the worker's model`);
  const wire = JSON.stringify(mainRequest ?? {});
  expect(wire.includes(MARKER), `${run.label}: AGENTS.md was not loaded from a cold config dir`);
  expect(
    wire.includes(UNATTENDED_INSTRUCTION.slice(0, 40)) &&
      wire.includes(NARRATION_INSTRUCTION.slice(0, 40)),
    `${run.label}: forge's instructions were not appended to the system prompt`,
  );
  expectNoAttribution(run.label, mainRequest);
  if (reasoningEffort !== undefined) {
    const effort = mainRequest?.output_config?.effort;
    expect(
      effort !== undefined,
      `${run.label}: reasoning effort ${reasoningEffort} did not reach the request (${JSON.stringify(mainRequest?.output_config)})`,
    );
  }
  return init;
};

for (const reasoningEffort of [undefined, ...REASONING_EFFORTS]) {
  const label = `effort ${reasoningEffort ?? 'none'}`;
  const before = requests.length;
  const run = await runClaude(label, reasoningEffort, join(scratch, `cold-${label.replace(' ', '-')}`));
  check(run, before, reasoningEffort);
}

const warmConfig = join(scratch, 'warm');
const coldRun = await runClaude('cold config dir', undefined, warmConfig);
const warmRun = await runClaude('warm config dir', undefined, warmConfig);
const normalised = (run) => {
  const init = events(run).find(
    (event) => event.type === 'system' && event.subtype === 'init',
  );
  return Object.fromEntries(
    Object.entries(init ?? {}).filter(([name]) => !PER_PROCESS_INIT_FIELDS.includes(name)),
  );
};
const cold = JSON.stringify(normalised(coldRun), null, 1);
const warm = JSON.stringify(normalised(warmRun), null, 1);
expect(
  cold === warm,
  `the init event differs between a cold and a warm config dir beyond ${PER_PROCESS_INIT_FIELDS.join(', ')}:\ncold ${cold}\nwarm ${warm}`,
);
expect(
  cold !== '{}',
  'the init event carries no fields to compare between a cold and a warm config dir',
);

server.close();

const runScenario = async (label, { respond, prompt, files = {}, args }) => {
  const sent = [];
  const subagentServer = await serveMessages(respond, sent);
  const dir = mkdtempSync(join(scratch, 'scenario-'));
  const work = join(dir, 'work');
  mkdirSync(work);
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), contents);
  }
  const run = await runClaude(label, undefined, join(dir, 'config'), {
    work,
    prompt,
    args,
    endpoint: subagentServer.address().port,
  });
  subagentServer.close();
  expect(run.code === 0, `${label}: claude exited ${run.code}: ${run.stderr.slice(0, 400)}`);
  const index = (() => {
    try {
      return readFileSync(join(run.bodiesDir, 'index.jsonl'), 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  })();
  return { stream: events(run), sent, index };
};

const subagents = await runScenario('two subagents', subagentsScenario());
const children = subagents.sent.filter(isSubagentRequest);
expect(children.length > 0, 'two subagents: no subagent request reached the fake endpoint');
for (const request of children) {
  const wire = JSON.stringify(request.system);
  expect(
    wire.includes(UNATTENDED_INSTRUCTION.slice(0, 40)) &&
      wire.includes(NARRATION_INSTRUCTION.slice(0, 40)),
    "two subagents: forge's instructions were not appended to a subagent's system prompt",
  );
  expectNoAttribution('two subagents', request);
  expect(
    !toolNames(request).includes('Agent'),
    'two subagents: a subagent was allowed to spawn a subagent of its own',
  );
}
const scoped = (line, scope) =>
  line.type === 'assistant' && line.parent_tool_use_id === scope;
expect(
  ['toolu_alpha', 'toolu_beta'].every((scope) =>
    subagents.stream.some((line) => scoped(line, scope)),
  ),
  "two subagents: stream-json no longer tags each subagent's assistant messages with the id of the tool call that spawned it",
);
expect(
  subagents.stream.some(
    (line) =>
      scoped(line, 'toolu_alpha') &&
      line.message.content.some(
        (block) => block.type === 'tool_use' && block.name === 'Skill',
      ),
  ),
  "two subagents: a subagent's Skill tool call did not appear in stream-json with its spawning call's id",
);
expect(
  subagents.stream.some(
    (line) =>
      line.type === 'user' &&
      line.parent_tool_use_id === 'toolu_alpha' &&
      JSON.stringify(line.message.content).includes('Launching skill: other-skill'),
  ),
  "two subagents: a subagent's Skill tool result did not appear in stream-json with its spawning call's id",
);
expect(
  ['toolu_alpha', 'toolu_beta'].every((id) =>
    subagents.stream.some(
      (line) =>
        line.type === 'user' &&
        line.parent_tool_use_id === null &&
        JSON.stringify(line.message.content).includes(id) &&
        JSON.stringify(line.message.content).includes('Report from'),
    ),
  ),
  "two subagents: an Agent call's result is no longer the report its subagent handed back",
);

const SPAWNED = 6;
const capped = await runScenario('subagent cap', {
  ...manySubagentsScenario(SPAWNED),
  files: RAISED_LIMIT_FILES,
});
const refusals = capped.stream.filter(
  (line) =>
    line.type === 'user' &&
    line.parent_tool_use_id === null &&
    JSON.stringify(line.message.content).includes(SUBAGENT_LIMIT_REFUSAL),
).length;
expect(
  refusals === SPAWNED - 4,
  `subagent cap: ${refusals} of ${SPAWNED} concurrent subagent calls were refused, expected ${SPAWNED - 4}, with the checkout's own settings raising the limits`,
);
expect(
  !capped.stream.some((line) => JSON.stringify(line).includes('Async agent launched')),
  "subagent cap: a subagent was launched in the background with the checkout's own settings enabling background tasks",
);
expect(
  capped.sent.filter(isSubagentRequest).every((request) => !toolNames(request).includes('Agent')),
  "subagent cap: a subagent was allowed to spawn one of its own with the checkout's own settings raising the depth",
);

const retried = await runScenario('retry', retryScenario());
const apiRetry = retried.stream.find(
  (line) => line.type === 'system' && line.subtype === 'api_retry',
);
expect(
  apiRetry !== undefined &&
    Number.isInteger(apiRetry.attempt) &&
    Number.isInteger(apiRetry.max_retries) &&
    Number.isInteger(apiRetry.retry_delay_ms) &&
    Number.isInteger(apiRetry.error_status) &&
    typeof apiRetry.error === 'string',
  `retry: stream-json no longer carries a system api_retry event with attempt, max_retries, retry_delay_ms, error_status and error: ${JSON.stringify(apiRetry)}`,
);
expect(
  retried.index.length === 1,
  'retry: the raw API bodies index recorded the failed attempt, which was never billed',
);

const compacted = await runScenario('compaction', compactionScenario());
const boundary = compacted.stream.find(
  (line) => line.type === 'system' && line.subtype === 'compact_boundary',
);
const meta = boundary?.compact_metadata;
expect(
  meta !== undefined &&
    typeof meta.trigger === 'string' &&
    Number.isInteger(meta.pre_tokens) &&
    Number.isInteger(meta.post_tokens),
  `compaction: stream-json no longer carries a system compact_boundary event with compact_metadata trigger, pre_tokens and post_tokens: ${JSON.stringify(boundary)}`,
);
const handoffAt = compacted.stream.findIndex(
  (line) =>
    line.type === 'user' &&
    JSON.stringify(line.message.content).includes(
      'This session is being continued from a previous conversation',
    ),
);
expect(
  handoffAt > compacted.stream.indexOf(boundary),
  'compaction: stream-json no longer carries the summary claude continues from after the compact_boundary event',
);
expect(
  compacted.index.filter((entry) => entry.query_source === 'compact').length === 1,
  "compaction: the raw API bodies index no longer marks the summarizing request with query_source compact",
);

const subagentCompacted = await runScenario('subagent compaction', subagentCompactionScenario());
expect(
  subagentCompacted.stream.some(
    (line) =>
      line.type === 'user' &&
      line.parent_tool_use_id === 'toolu_alpha' &&
      JSON.stringify(line.message.content).includes(
        'This session is being continued from a previous conversation',
      ),
  ),
  "subagent compaction: stream-json no longer carries the summary a compacting subagent continues from as a user message with its spawning call's id",
);
expect(
  !subagentCompacted.stream.some(
    (line) => line.type === 'system' && line.subtype === 'compact_boundary',
  ),
  'subagent compaction: stream-json now carries a compact_boundary event for a subagent, which the runner would treat as the parent\'s',
);
expect(
  subagentCompacted.index.filter((entry) => entry.query_source === 'compact').length === 1,
  'subagent compaction: the raw API bodies index no longer marks the summarizing request with query_source compact',
);

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
