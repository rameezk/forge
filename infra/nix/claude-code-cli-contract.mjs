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
const { serveMessages, CLAUDE_TOKEN } = await import(
  join(fixtures, 'fake-anthropic.ts')
);
const { anthropicReply, anthropicSse, anthropicUsage } = await import(
  join(fixtures, 'fake-provider.ts')
);

const MARKER = 'contract check marker for the repository instructions';
const USAGE = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 };
const PER_PROCESS_INIT_FIELDS = ['messaging_socket_path', 'session_id', 'uuid'];

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

const runClaude = async (label, reasoningEffort, configDir) => {
  const bodiesDir = mkdtempSync(join(scratch, 'bodies-'));
  mkdirSync(configDir, { recursive: true });
  const args = claudeCodeArgs(
    {
      provider: 'anthropic',
      model: 'claude-opus-4-5',
      prompt: 'contract check',
      workDir,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    },
    { maxCostUsd: 1, extraArgs: [] },
  );
  const child = spawn(claude, args, {
    cwd: workDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      HOME: home,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
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
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
