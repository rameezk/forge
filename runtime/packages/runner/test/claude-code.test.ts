import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseTranscript,
  rawEventsRef,
  Store,
  type GenerationRecord,
  type RunRecord,
  type SkillLoadEvent,
} from '@forge/shared';
import { ClaudeCodeHarness, type WorkerConfig } from '../src/index.ts';
import { main as bill } from '../src/billing-main.ts';
import { main } from '../src/main.ts';
import {
  fakeOpenRouter,
  billedAt,
  claudeReplay,
  commandPath,
  writeFakeBwrap,
  writeFakeClaude,
  type BwrapCall,
  isAlive,
} from './helpers.ts';
import { CLAUDE_TOKEN } from './fixtures/fake-anthropic.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'claude-code');

const MODEL = 'claude-opus-4-5';

const OPUS_PRICE = {
  prompt: '0.000005',
  completion: '0.000025',
  input_cache_read: '0.0000005',
  input_cache_write: '0.00000625',
};

const OPENROUTER_MODELS = {
  data: [{ id: 'anthropic/claude-opus-4.5', pricing: OPUS_PRICE }],
};

const listPriceOf = ([input, output, cacheRead, cacheWrite]: [
  number,
  number,
  number,
  number,
]): number =>
  input * Number(OPUS_PRICE.prompt) +
  output * Number(OPUS_PRICE.completion) +
  cacheRead * Number(OPUS_PRICE.input_cache_read) +
  cacheWrite * Number(OPUS_PRICE.input_cache_write);

interface Scenario {
  fixture: string;
  worker?: Partial<WorkerConfig>;
  env?: NodeJS.ProcessEnv;
  models?: unknown;
  lingerMs?: number;
  indexAs?: 'fifo' | 'symlink';
  rewrite?: (stream: string) => string;
}

interface Outcome {
  rawEvents: string;
  code: number;
  stateDir: string;
  run: RunRecord;
  generations: GenerationRecord[];
  transcript: string;
  claudeStarted: boolean;
  claude: {
    argv: string[];
    env: Record<string, string>;
    pid: number;
    modes: { run: number; config: number; bodies: number };
  };
  bwrap: BwrapCall;
}

const runClaude = async ({
  fixture,
  worker,
  env,
  models = OPENROUTER_MODELS,
  lingerMs,
  indexAs,
  rewrite,
}: Scenario): Promise<Outcome> => {
  const stateDir = mkdtempSync(join(tmpdir(), 'forge-claude-'));
  const fakeClaude = writeFakeClaude(stateDir);
  const claudeRecord = join(stateDir, 'claude-call.json');
  const bwrapRecord = join(stateDir, 'bwrap-call.json');
  const recorded = join(FIXTURES, fixture);
  const stream = join(stateDir, 'stream.jsonl');
  writeFileSync(
    stream,
    (rewrite ?? ((text: string) => text))(readFileSync(join(recorded, 'stream.jsonl'), 'utf8')),
  );
  const fakeBwrap = writeFakeBwrap(stateDir, {
    record: bwrapRecord,
    harnessEnv: {
      ...claudeReplay(fixture, claudeRecord),
      FAKE_CLAUDE_STREAM: stream,
      ...(lingerMs === undefined ? {} : { FAKE_CLAUDE_LINGER_MS: String(lingerMs) }),
      ...(indexAs === 'fifo' ? { FAKE_CLAUDE_MKFIFO: commandPath('mkfifo') } : {}),
      ...(indexAs === undefined ? {} : { FAKE_CLAUDE_INDEX: indexAs }),
    },
  });
  const configPath = join(stateDir, 'runtime.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      harnesses: { 'claude-code': { command: fakeClaude } },
      workers: {
        refiner: {
          harness: 'claude-code',
          model: MODEL,
          prompt: 'refine the spec',
          ...worker,
        },
      },
      dispatch: {
        gitIdentity: { name: 'Forge Operator', email: 'operator@example.com' },
      },
    }),
  );
  const openRouter = await fakeOpenRouter(billedAt({}), models);
  let code: number;
  try {
    code = await main(['refiner'], {
      OPENROUTER_BASE_URL: openRouter.baseUrl,
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN,
      HOME: '/var/empty',
      FORGE_RUNTIME_CONFIG: configPath,
      FORGE_STATE_DIR: stateDir,
      FORGE_BWRAP: fakeBwrap,
      ...env,
    });
  } finally {
    openRouter.close();
  }
  const store = Store.open(join(stateDir, 'forge.db'));
  try {
    const [run] = store.listRuns();
    assert.ok(run);
    return {
      code,
      rawEvents: readFileSync(join(stateDir, 'transcripts', rawEventsRef(run.id)), 'utf8'),
      stateDir,
      run,
      generations: store.listGenerations(run.id),
      transcript: readFileSync(join(stateDir, 'transcripts', `${run.id}.jsonl`), 'utf8'),
      claudeStarted: existsSync(claudeRecord),
      get claude() {
        return JSON.parse(readFileSync(claudeRecord, 'utf8')) as Outcome['claude'];
      },
      get bwrap() {
        return JSON.parse(readFileSync(bwrapRecord, 'utf8')) as BwrapCall;
      },
    };
  } finally {
    store.close();
  }
};

test('given a claude-code worker on a two-request recording, when its workload runs through the runner, then each request is a generation keyed by its Anthropic request id with its four token counts and a list-price equivalent, and the run stays on subscription', async () => {
  const { code, run, generations } = await runClaude({ fixture: 'success' });

  assert.equal(code, 0);
  assert.equal(run.status, 'success');
  assert.equal(run.harness, 'claude-code');
  assert.equal(run.costStatus, 'subscription');
  assert.equal(run.costUsd, 0);
  assert.deepEqual(
    generations.map(({ generationId, billedCostUsd, estimatedCostUsd, attempts }) => [
      generationId,
      billedCostUsd,
      estimatedCostUsd,
      attempts,
    ]),
    [
      ['req_forge_success_1', null, null, 0],
      ['req_forge_success_2', null, null, 0],
    ],
  );
  assert.deepEqual(
    generations.map(({ listPriceEquivalentUsd }) => Number(listPriceEquivalentUsd?.toFixed(9))),
    [
      Number(listPriceOf([200, 40, 0, 1000]).toFixed(9)),
      Number(listPriceOf([300, 25, 1000, 200]).toFixed(9)),
    ],
  );
  assert.equal(run.inputTokens, 500);
  assert.equal(run.outputTokens, 65);
  assert.equal(run.cacheReadTokens, 1000);
  assert.equal(run.cacheWriteTokens, 1200);
});

test('given a claude-code worker on a two-request recording, when its workload runs, then the transcript reads in order with thinking, text, the tool call and its result, the stop reasons and usage, and the session id and harness version are recorded', async () => {
  const { run, transcript } = await runClaude({ fixture: 'success' });

  const events = parseTranscript(transcript).filter(({ type }) => type !== 'result');
  assert.deepEqual(
    events.map((event) => event.type),
    ['message', 'message', 'tool_call', 'tool_result', 'message'],
  );
  const [prompt, first, call, toolResult, last] = events as unknown as [
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>,
  ];
  assert.equal(prompt.role, 'user');
  assert.equal(first.role, 'assistant');
  assert.equal(first.text, 'Let me look.');
  assert.equal(first.thinking, 'I should run the command and read what it prints.');
  assert.equal(first.stopReason, 'tool_use');
  assert.deepEqual(first.usage, {
    inputTokens: 200,
    outputTokens: 40,
    cacheReadTokens: 0,
    cacheWriteTokens: 1000,
  });
  assert.match(String(first.timestamp), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(call.name, 'Bash');
  assert.deepEqual(call.arguments, { command: 'echo forge' });
  assert.equal(toolResult.id, call.id);
  assert.equal(toolResult.isError, false);
  assert.equal(toolResult.text, 'forge');
  assert.equal(last.text, 'The command printed forge. All done.');
  assert.equal(last.stopReason, 'end_turn');
  assert.match(run.sessionId ?? '', /^[0-9a-f-]{36}$/);
});

test('given a claude-code worker on a recording of two parallel subagents, when its workload runs, then each subagent\'s messages, tool calls, results and generations carry the id of the tool call that spawned it, and the parent\'s carry none', async () => {
  const { code, run, generations, transcript } = await runClaude({ fixture: 'subagents' });

  assert.equal(code, 0);
  assert.equal(run.status, 'success');
  const events = parseTranscript(transcript) as unknown as Record<string, unknown>[];
  const scoped = (scope: string | undefined): string[] =>
    events.flatMap((event) =>
      event.subagent === scope
        ? [
            event.type === 'message'
              ? String(event.text)
              : event.type === 'tool_call'
                ? `call ${String(event.name)}`
                : event.type === 'tool_result'
                  ? 'result'
                  : String(event.type),
          ]
        : [],
    );
  assert.deepEqual(scoped('toolu_alpha'), [
    'Loading the other skill.',
    'call Skill',
    'result',
    'Report from alpha.',
  ]);
  assert.deepEqual(scoped('toolu_beta'), ['Report from beta.']);
  const parentMessages = events.filter(
    (event) => event.type === 'message' && event.role === 'assistant' && event.subagent === undefined,
  );
  assert.deepEqual(
    parentMessages.map((event) => event.text),
    [
      'Two subagents will take it from here.',
      'Both subagents reported. All done.',
      'Both subagents reported. All done.',
    ],
  );
  const byScope = Object.fromEntries(
    generations.map(({ generationId, subagent }) => [generationId, subagent]),
  );
  assert.deepEqual(byScope, {
    req_forge_subagents_parent_1: null,
    req_forge_subagents_alpha_1: 'toolu_alpha',
    req_forge_subagents_beta_1: 'toolu_beta',
    req_forge_subagents_alpha_2: 'toolu_alpha',
    req_forge_subagents_parent_2: null,
    req_forge_subagents_parent_3: null,
  });
  assert.equal(generations.length, 6);
});

const skillLoadsOf = async (
  fixture: string,
  prompt: string,
  skills: string[],
): Promise<SkillLoadEvent[]> => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-claude-skills-'));
  const root = join(dir, 'repo');
  const files = new Map(
    skills.map((name) => [name, [join(root, '.claude', 'skills', name, 'SKILL.md')]]),
  );
  const harness = new ClaudeCodeHarness({
    command: writeFakeClaude(dir),
    runsDir: join(dir, 'runs'),
    maxCostUsd: null,
    sandbox: {
      bwrap: writeFakeBwrap(dir, {
        record: join(dir, 'bwrap-call.json'),
        harnessEnv: claudeReplay(fixture, join(dir, 'claude-call.json')),
      }),
      home: dir,
    },
    system: { PATH: process.env.PATH ?? '' },
    env: {},
  });
  const loads: SkillLoadEvent[] = [];
  for await (const event of harness
    .open({ runId: 'run-1', model: MODEL, listedModel: null })
    .run(
      {
        provider: 'anthropic',
        model: MODEL,
        prompt,
        workDir: dir,
        checkout: {
          root,
          skillPaths: [],
          projectInstructions: null,
          systemPrompt: null,
          appendSystemPrompt: null,
          skills: files,
          skillLines: new Map([...files.values()].map(([file]) => [file as string, 7])),
        },
      },
      { stop: new AbortController().signal, rawEvent: () => {}, requestRecord: () => {} },
    )) {
    if (event.type === 'skill_load') loads.push(event);
  }
  return loads;
};

test('given a claude-code worker starting with a skill command and a recording where a subagent invokes another skill, when it runs, then each load is recorded in its own scope with complete coverage', async () => {
  const loads = await skillLoadsOf('subagents', '/first-skill start the work', [
    'first-skill',
    'other-skill',
  ]);

  const final = new Map(
    loads.map((load) => [`${load.subagent ?? ''}:${load.skill}`, load]),
  );
  assert.deepEqual([...final.keys()].sort(), [':first-skill', 'toolu_alpha:other-skill']);
  assert.deepEqual(final.get(':first-skill'), {
    type: 'skill_load',
    skill: 'first-skill',
    source: 'prompt',
    subagent: null,
    coverage: { coveredLines: 7, totalLines: 7 },
  });
  assert.deepEqual(final.get('toolu_alpha:other-skill'), {
    type: 'skill_load',
    skill: 'other-skill',
    source: 'read',
    subagent: 'toolu_alpha',
    coverage: { coveredLines: 7, totalLines: 7 },
  });
});

test('given a claude-code worker whose provider rejects the model, when its workload runs, then the run ends error with the provider\'s message and the runner exits as for a failure', async () => {
  const { code, run, generations } = await runClaude({ fixture: 'provider-error' });

  assert.equal(code, 1);
  assert.equal(run.status, 'error');
  assert.match(run.error ?? '', /API Error: 400.*claude-opus-4-5 is not a valid model ID/);
  assert.equal(run.costStatus, 'subscription');
  assert.deepEqual(generations, []);
});

test('given a claude-code worker whose provider answers with a usage limit, when its workload runs, then the run ends error with the provider\'s message', async () => {
  const { code, run } = await runClaude({ fixture: 'usage-limit' });

  assert.equal(code, 1);
  assert.equal(run.status, 'error');
  assert.match(run.error ?? '', /You've hit your limit - resets 4pm/);
});

test('given a claude-code worker with a budget the first generation\'s list-price equivalent passes and a claude that keeps running, when it runs, then claude is killed and the run ends exceeded on its budget', async () => {
  const { code, run, claude } = await runClaude({
    fixture: 'success',
    lingerMs: 10_000,
    worker: { maxCostUsd: 0.005 },
  });

  assert.equal(code, 1);
  assert.equal(run.status, 'exceeded');
  assert.equal(run.exceededLimit, 'budget');
  assert.equal(run.maxCostUsd, 0.005);
  assert.equal(isAlive(claude.pid), false);
  assert.deepEqual(claude.argv.slice(claude.argv.indexOf('--max-budget-usd'), -2).slice(0, 2), [
    '--max-budget-usd',
    '0.005',
  ]);
});

const untilFirstToolCall = (stream: string): string => {
  const lines = stream.split('\n').filter((line) => line !== '');
  const last = lines.findIndex((line) => line.includes('"type":"tool_use"'));
  return `${lines.slice(0, last + 1).join('\n')}\n`;
};

test('given a claude-code worker with a budget its first tool-calling request already passes and a claude still running that tool, when it runs, then the run ends exceeded without waiting for the tool to finish', async () => {
  const started = Date.now();
  const { run, claude } = await runClaude({
    fixture: 'success',
    rewrite: untilFirstToolCall,
    lingerMs: 30_000,
    worker: { maxCostUsd: 0.005 },
  });

  assert.equal(run.status, 'exceeded');
  assert.equal(run.exceededLimit, 'budget');
  assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
  assert.equal(isAlive(claude.pid), false);
});

for (const indexAs of ['fifo', 'symlink'] as const) {
  test(`given a claude-code workload that leaves a ${indexAs} where claude's request index belongs, when the runner reads the recorded usage, then it neither blocks nor follows it and the run ends error saying no usage was recorded`, { timeout: 40_000 }, async () => {
    const { run, generations } = await runClaude({ fixture: 'success', indexAs });

    assert.equal(run.status, 'error');
    assert.match(run.error ?? '', /claude recorded no usage for its response/);
    assert.deepEqual(generations, []);
  });
}

test('given a claude-code worker with a budget its list-price equivalents stay under, when it runs, then the workload succeeds', async () => {
  const { code, run } = await runClaude({ fixture: 'success', worker: { maxCostUsd: 1 } });

  assert.equal(code, 0);
  assert.equal(run.status, 'success');
});

test('given a budgeted claude-code worker whose model has no OpenRouter mapping, when it runs, then claude never starts and the run ends error saying the model could not be priced', async () => {
  const outcome = await runClaude({
    fixture: 'success',
    worker: { model: 'claude-unpriced', maxCostUsd: 5 },
  });

  assert.equal(outcome.code, 1);
  assert.equal(outcome.claudeStarted, false);
  assert.equal(outcome.run.status, 'error');
  assert.match(outcome.run.error ?? '', /claude-unpriced.*could not be priced/);
});

test('given a budgeted claude-code worker whose mapped model OpenRouter does not list, when it runs, then claude never starts and the run ends error saying the model could not be priced', async () => {
  const outcome = await runClaude({
    fixture: 'success',
    models: { data: [] },
    worker: { maxCostUsd: 5 },
  });

  assert.equal(outcome.claudeStarted, false);
  assert.match(outcome.run.error ?? '', /could not be priced/);
});

test('given an unbudgeted claude-code worker whose model has no OpenRouter mapping, when it runs, then the workload runs with no list-price equivalent', async () => {
  const outcome = await runClaude({
    fixture: 'success',
    worker: { model: 'claude-unpriced' },
  });

  assert.equal(outcome.code, 0);
  assert.deepEqual(
    outcome.generations.map(({ listPriceEquivalentUsd }) => listPriceEquivalentUsd),
    [null, null],
  );
});

test('given a runner environment holding an Anthropic API key, an auth token, the OpenRouter key and the OAuth token, when a claude-code workload runs, then the sandbox holds the OAuth token alone', async () => {
  const outcome = await runClaude({
    fixture: 'success',
    env: {
      ANTHROPIC_API_KEY: 'sk-ant-api03-forge-test-key',
      ANTHROPIC_AUTH_TOKEN: 'forge-test-auth-token',
      OPENROUTER_API_KEY: 'sk-or-forge-test-key',
    },
  });

  const { env } = outcome.bwrap;
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_TOKEN);
  for (const withheld of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENROUTER_API_KEY']) {
    assert.equal(withheld in env, false, withheld);
    assert.equal(withheld in outcome.claude.env, false, withheld);
  }
});

test('given a claude-code workload whose agent echoes the token in a command and in its reply, when the transcript and raw events are written, then the token reaches neither', async () => {
  const outcome = await runClaude({
    fixture: 'success',
    rewrite: (stream) =>
      stream
        .replaceAll('echo forge', `echo ${CLAUDE_TOKEN}`)
        .replaceAll('All done.', `The token is ${CLAUDE_TOKEN}.`),
  });

  assert.doesNotMatch(outcome.transcript, /sk-ant-oat/);
  assert.doesNotMatch(outcome.rawEvents, /sk-ant-oat/);
  assert.match(outcome.transcript, /redacted/);
});

test('given a claude-code worker with an effort and a budget, when its workload runs, then claude gets the flags forge relies on, the forge instructions appended to the system prompt and the prompt last', async () => {
  const { claude } = await runClaude({
    fixture: 'success',
    worker: { reasoningEffort: 'ultracode', maxCostUsd: 1 },
  });

  const { argv } = claude;
  const after = (flag: string): string | undefined => argv[argv.indexOf(flag) + 1];
  assert.deepEqual(argv.slice(0, 4), ['-p', '--output-format', 'stream-json', '--verbose']);
  assert.ok(argv.includes('--no-session-persistence'));
  assert.ok(argv.includes('--dangerously-skip-permissions'));
  assert.equal(after('--model'), MODEL);
  assert.equal(after('--effort'), 'ultracode');
  assert.equal(after('--disallowedTools'), 'AskUserQuestion');
  assert.equal(after('--max-budget-usd'), '1');
  assert.match(after('--append-system-prompt') ?? '', /running unattended/);
  assert.match(after('--append-system-prompt') ?? '', /Narrate your work/);
  assert.equal(after('--append-subagent-system-prompt'), after('--append-system-prompt'));
  assert.equal(argv.includes('--system-prompt'), false);
  assert.equal(argv.includes('--bare'), false);
  assert.deepEqual(argv.slice(-2), ['--', 'refine the spec']);
});

test('given a claude-code workload, when it runs, then the per-run dirs are private to the runner user and claude exports telemetry to no collector', async () => {
  const { claude } = await runClaude({ fixture: 'success' });

  assert.deepEqual(claude.modes, { run: 0o700, config: 0o700, bodies: 0o700 });
  assert.equal(claude.env.OTEL_METRICS_EXPORTER, 'none');
  assert.equal(claude.env.OTEL_TRACES_EXPORTER, 'none');
});

test('given a claude-code workload, when it runs, then claude may spawn subagents one level deep and four at once, as pi does', async () => {
  const { claude } = await runClaude({ fixture: 'success' });

  assert.equal(claude.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, '1');
  assert.equal(claude.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, '4');
});

test('given a claude-code workload, when it runs, then claude gets an empty per-run config dir inside the sandbox state, telemetry on and auto-update off, and the dir is gone after the run', async () => {
  const { claude, bwrap, stateDir, run } = await runClaude({ fixture: 'success' });

  const configDir = claude.env.CLAUDE_CONFIG_DIR ?? '';
  assert.equal(configDir, join(stateDir, 'agent', run.id, 'config'));
  assert.equal(claude.env.DISABLE_AUTOUPDATER, '1');
  assert.equal(claude.env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
  assert.equal(claude.env.OTEL_LOGS_EXPORTER, 'none');
  assert.equal(claude.env.OTEL_LOG_RAW_API_BODIES, `file:${join(stateDir, 'agent', run.id, 'bodies')}`);
  const binds = bwrap.argv.flatMap((arg, index) =>
    bwrap.argv[index - 1] === '--bind' ? [arg] : [],
  );
  assert.ok(binds.includes(configDir));
  assert.equal(existsSync(join(stateDir, 'agent', run.id)), false);
});

test('given a subscription workload, when it finishes and the billing service fires, then billing neither looks up nor changes any generation', async () => {
  const outcome = await runClaude({ fixture: 'success' });
  const openRouter = await fakeOpenRouter(billedAt({}), OPENROUTER_MODELS);
  try {
    const before = JSON.stringify(outcome.generations);
    const code = await bill({
      FORGE_STATE_DIR: outcome.stateDir,
      OPENROUTER_BASE_URL: openRouter.baseUrl,
      OPENROUTER_API_KEY: 'sk-or-forge-test-key',
    });
    const store = Store.open(join(outcome.stateDir, 'forge.db'));
    try {
      assert.equal(code, 0);
      assert.deepEqual(openRouter.lookups, []);
      assert.equal(JSON.stringify(store.listGenerations(outcome.run.id)), before);
      assert.equal(store.listRuns()[0]?.costStatus, 'subscription');
    } finally {
      store.close();
    }
  } finally {
    openRouter.close();
  }
});
