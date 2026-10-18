import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseTranscript,
  rawEventsRef,
  requestRecordRef,
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
  skillCheckout,
  writeFakeBwrap,
  writeFakeClaude,
  type BwrapCall,
  isAlive,
} from './helpers.ts';
import { CLAUDE_SKILL_FILES, CLAUDE_TOKEN } from './fixtures/fake-anthropic.ts';

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
  requests?: Record<string, unknown>;
}

interface Outcome {
  rawEvents: string;
  code: number;
  stateDir: string;
  run: RunRecord;
  generations: GenerationRecord[];
  transcript: string;
  requestRecord: Record<string, unknown>[];
  claudeStarted: boolean;
  claude: {
    argv: string[];
    cwd: string;
    env: Record<string, string>;
    pid: number;
    modes: { run: number; config: number; bodies: number };
  };
  bwrap: BwrapCall;
}

const parseRecord = (path: string): Record<string, unknown>[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];

const runClaude = async ({
  fixture,
  worker,
  env,
  models = OPENROUTER_MODELS,
  lingerMs,
  indexAs,
  rewrite,
  requests = {},
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
  const bodies = join(stateDir, 'recorded-bodies');
  if (existsSync(join(recorded, 'bodies'))) {
    cpSync(join(recorded, 'bodies'), bodies, { recursive: true });
  }
  for (const [file, body] of Object.entries(requests)) {
    writeFileSync(join(bodies, file), JSON.stringify(body));
  }
  const fakeBwrap = writeFakeBwrap(stateDir, {
    record: bwrapRecord,
    harnessEnv: {
      ...claudeReplay(fixture, claudeRecord),
      FAKE_CLAUDE_STREAM: stream,
      FAKE_CLAUDE_BODIES: bodies,
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
      requestRecord: parseRecord(
        join(stateDir, 'transcripts', requestRecordRef(run.id)),
      ),
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

const SYSTEM_BLOCKS = [
  { type: 'text', text: 'You are Claude Code.', cache_control: { type: 'ephemeral' } },
  { type: 'text', text: 'Be brief.' },
];

const TOOLS = [
  {
    name: 'Bash',
    description: 'Runs a command',
    input_schema: { type: 'object', properties: { command: { type: 'string' } } },
  },
];

const requestBody = (messages: unknown[], system: unknown[] = SYSTEM_BLOCKS) => ({
  model: MODEL,
  system,
  tools: TOOLS,
  messages,
  max_tokens: 32000,
  stream: true,
});

const SUCCESS_REQUESTS = {
  '7d838a06-085b-4316-acfe-42673768a9f9.request.json': requestBody([
    { role: 'user', content: [{ type: 'text', text: 'refine the spec' }] },
  ]),
  'a9815516-cd0f-4b58-9aa4-02e8a9dc2d20.request.json': requestBody([
    { role: 'user', content: [{ type: 'text', text: 'refine the spec' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Let me look.' }] },
  ]),
};

test('given a claude-code worker whose requests were recorded, when its workload runs, then the run\'s request record holds the system prompt and tools once and each request referring to them, with the cache markers lifted out', async () => {
  const { code, requestRecord } = await runClaude({
    fixture: 'success',
    requests: SUCCESS_REQUESTS,
  });

  assert.equal(code, 0);
  assert.deepEqual(
    requestRecord.map(({ type }) => type),
    ['system_prompt', 'tools', 'request', 'request'],
  );
  const [system, tools, first, second] = requestRecord as [
    { hash: string; value: unknown },
    { hash: string; tools: unknown },
    { body: Record<string, unknown>; cacheMarkers: unknown[]; subagent?: string },
    { body: Record<string, unknown> },
  ];
  assert.deepEqual(system.value, [
    { type: 'text', text: 'You are Claude Code.' },
    { type: 'text', text: 'Be brief.' },
  ]);
  assert.deepEqual(tools.tools, TOOLS);
  assert.deepEqual(first.body.system, { hash: system.hash });
  assert.deepEqual(first.body.tools, { hash: tools.hash });
  assert.deepEqual(second.body.system, { hash: system.hash });
  assert.equal((second.body.messages as unknown[]).length, 2);
  assert.deepEqual(first.cacheMarkers, [
    { path: ['system', 0], value: { type: 'ephemeral' } },
  ]);
  assert.equal(first.subagent, undefined);
});

interface Snapshot {
  buildSuffix: string;
  date: string;
  status: string;
  persona?: string;
}

const perRunSystem = ({ buildSuffix, date, status, persona = 'You are Claude Code.' }: Snapshot) => [
  { type: 'text', text: `x-anthropic-billing-header: cc_version=2.1.296.${buildSuffix}; cc_entrypoint=sdk-cli;` },
  {
    type: 'text',
    text: `${persona} Your work dir is {{WORK_DIR}}. Memory lives in {{CONFIG_DIR}}/projects/{{WORK_DIR_SLUG}}/memory/.`,
  },
  {
    type: 'text',
    text: `Today's date is ${date}.\n# gitStatus\nThis is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.\n\nCurrent branch: main\n\nStatus:\n${status}\n\nRecent commits:\nabc init\n\nClaude Code attached this context.`,
  },
];

const snapshotRequests = (snapshot: Snapshot) => ({
  '7d838a06-085b-4316-acfe-42673768a9f9.request.json': requestBody(
    [{ role: 'user', content: [{ type: 'text', text: 'refine the spec' }] }],
    perRunSystem(snapshot),
  ),
});

const fingerprintOf = ({ stateDir, run }: Outcome) => {
  const store = Store.open(join(stateDir, 'forge.db'));
  try {
    return store.getFingerprint(run.id);
  } finally {
    store.close();
  }
};

const MORNING: Snapshot = { buildSuffix: 'a7e', date: '2026-10-13', status: '?? notes.md' };

test('given two claude-code runs of one worker whose per-run values differ - work dir, config dir, build suffix, date and git status - when each runs, then both fingerprints hash alike', async () => {
  const first = await runClaude({ fixture: 'success', requests: snapshotRequests(MORNING) });
  const second = await runClaude({
    fixture: 'success',
    requests: snapshotRequests({ buildSuffix: '1ec', date: '2026-11-02', status: ' M src/a.ts\n?? b.ts' }),
  });

  const [one, two] = [fingerprintOf(first), fingerprintOf(second)];
  assert.ok(one);
  assert.ok(two);
  assert.notEqual(first.claude.env.CLAUDE_CONFIG_DIR, second.claude.env.CLAUDE_CONFIG_DIR);
  assert.notEqual(first.claude.cwd, second.claude.cwd);
  assert.equal(one.fingerprint.harness, 'claude-code');
  assert.equal(one.fingerprint.settings, undefined);
  assert.equal(one.fingerprint.systemPrompt, two.fingerprint.systemPrompt);
  assert.equal(one.hash, two.hash);
});

test('given two claude-code runs whose system prompts differ in their own text, when each runs, then their fingerprints hash differently', async () => {
  const first = await runClaude({ fixture: 'success', requests: snapshotRequests(MORNING) });
  const second = await runClaude({
    fixture: 'success',
    requests: snapshotRequests({ ...MORNING, persona: 'You are a different agent.' }),
  });

  assert.notEqual(fingerprintOf(first)?.hash, fingerprintOf(second)?.hash);
});

test('given a claude-code worker on a recording of two parallel subagents whose requests were recorded, when its workload runs, then each subagent\'s request is recorded under the id of the tool call that spawned it and the parent\'s under none', async () => {
  const subagentSystem = [{ type: 'text', text: 'You are a subagent.' }];
  const user = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];
  const { code, requestRecord } = await runClaude({
    fixture: 'subagents',
    requests: {
      '2674eee4-1bf8-4f25-8481-c50e541b34e2.request.json': requestBody(user),
      '400902d3-9729-4072-89f4-def6a8c3a8ec.request.json': requestBody(user, subagentSystem),
      '5f27d403-fec9-4c8a-85b7-6280990f3b1b.request.json': requestBody(user, subagentSystem),
      '69701490-96c0-480d-b15e-79ed4bc09c73.request.json': requestBody(user, subagentSystem),
      '9350db0c-ce48-4fe8-a4fb-ec31cec2416a.request.json': requestBody(user),
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(
    requestRecord.flatMap((line) =>
      line.type === 'request' ? [String(line.subagent ?? 'parent')] : [],
    ),
    ['parent', 'toolu_alpha', 'toolu_beta', 'toolu_alpha', 'parent'],
  );
  assert.equal(requestRecord.filter(({ type }) => type === 'system_prompt').length, 2);
  assert.equal(requestRecord.filter(({ type }) => type === 'tools').length, 1);
});

test('given a claude-code worker on a recording whose request bodies were not kept, when its workload runs, then the run still succeeds with an empty request record', async () => {
  const { code, run, requestRecord } = await runClaude({ fixture: 'success' });

  assert.equal(code, 0);
  assert.equal(run.status, 'success');
  assert.deepEqual(requestRecord, []);
});

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
    generations.map(({ givenUpAt, lastError }) => [givenUpAt, lastError]),
    [[null, null], [null, null]],
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
    ['Two subagents will take it from here.', 'Both subagents reported. All done.'],
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
  });
  assert.equal(generations.length, 5);
});

test('given a claude-code worker on a recording of two parallel subagents, when its workload runs, then each Agent call\'s result is the report its subagent handed back, after that subagent\'s own messages', async () => {
  const { transcript } = await runClaude({ fixture: 'subagents' });

  const events = parseTranscript(transcript) as unknown as Record<string, unknown>[];
  const results = events.filter(
    (event) => event.type === 'tool_result' && event.subagent === undefined,
  );
  assert.deepEqual(
    results.map((event) => event.id),
    ['toolu_beta', 'toolu_alpha'],
  );
  for (const result of results) {
    const scope = String(result.id).replace('toolu_', '');
    assert.match(String(result.text), new RegExp(`Report from ${scope}\\.`));
    const last = events.findLastIndex((event) => event.subagent === result.id);
    assert.ok(last !== -1 && last < events.indexOf(result));
  }
});

test('given a claude-code worker whose first Agent call is answered before the same assistant message has delivered its second, when its workload runs, then that message is reported once and its second call still follows', async () => {
  const moveFirstResultEarly = (stream: string): string => {
    const lines = stream.split('\n');
    const result = lines.findIndex((line) =>
      line.includes('"tool_use_id":"toolu_alpha","type":"tool_result"'),
    );
    const second = lines.findIndex((line) => line.includes('"id":"toolu_beta"') && line.includes('"tool_use"'));
    const [moved] = lines.splice(result, 1);
    lines.splice(second, 0, moved as string);
    return lines.join('\n');
  };

  const { transcript } = await runClaude({
    fixture: 'subagents',
    rewrite: moveFirstResultEarly,
  });

  const events = parseTranscript(transcript) as unknown as Record<string, unknown>[];
  assert.deepEqual(
    events
      .filter((event) => event.type === 'tool_call' && event.name === 'Agent')
      .map((event) => event.id),
    ['toolu_alpha', 'toolu_beta'],
  );
  assert.equal(
    events.filter(
      (event) => event.type === 'message' && event.role === 'assistant' && event.subagent === undefined,
    ).length,
    2,
  );
});

test('given a claude-code worker whose first subagent is already answering a tool call before its parent message has delivered its second Agent call, when its workload runs, then the spawning Agent call still precedes everything the subagent did', async () => {
  const delaySecondCall = (stream: string): string => {
    const lines = stream.split('\n');
    const second = lines.findIndex((line) => line.includes('"id":"toolu_beta"') && line.includes('"tool_use"'));
    const skillResult = lines.findIndex((line) => line.includes('"tool_use_id":"toolu_skill"') && line.includes('"tool_result"'));
    const [moved] = lines.splice(second, 1);
    lines.splice(skillResult, 0, moved as string);
    return lines.join('\n');
  };

  const { transcript } = await runClaude({ fixture: 'subagents', rewrite: delaySecondCall });

  const events = parseTranscript(transcript) as unknown as Record<string, unknown>[];
  for (const id of ['toolu_alpha', 'toolu_beta']) {
    const call = events.findIndex((event) => event.type === 'tool_call' && event.id === id);
    const first = events.findIndex((event) => event.subagent === id);
    assert.ok(call !== -1 && first !== -1 && call < first, `${id} call at ${String(call)} after its first subagent event at ${String(first)}`);
  }
});

test('given a claude-code worker whose stream attributes a message to a tool call claude never made, when its workload runs, then the run ends error naming it and nothing is attributed to that call', async () => {
  const forge = (stream: string): string =>
    stream.replaceAll('"parent_tool_use_id":"toolu_beta"', '"parent_tool_use_id":"toolu_forged"');

  const { run, transcript } = await runClaude({ fixture: 'subagents', rewrite: forge });

  assert.equal(run.status, 'error');
  assert.match(run.error ?? '', /toolu_forged/);
  const events = parseTranscript(transcript) as unknown as Record<string, unknown>[];
  assert.ok(!events.some((event) => event.subagent === 'toolu_forged'));
});

test('given a claude-code worker whose stream attributes a tool result to a tool call claude never made, when its workload runs, then the run ends error naming it and the parent keeps the events it had', async () => {
  const forge = (stream: string): string =>
    stream
      .split('\n')
      .map((line) =>
        line.includes('"tool_use_id":"toolu_skill"') && line.includes('"tool_result"')
          ? line.replace('"parent_tool_use_id":"toolu_alpha"', '"parent_tool_use_id":"toolu_forged"')
          : line,
      )
      .join('\n');

  const clean = await runClaude({ fixture: 'subagents' });
  const { run, transcript } = await runClaude({ fixture: 'subagents', rewrite: forge });

  assert.equal(run.status, 'error');
  assert.match(run.error ?? '', /toolu_forged/);
  const unscoped = (text: string): number =>
    (parseTranscript(text) as unknown as Record<string, unknown>[]).filter(
      (event) => event.subagent === undefined && event.type !== 'tool_result',
    ).length;
  assert.ok(unscoped(transcript) > 0);
  assert.ok(unscoped(transcript) <= unscoped(clean.transcript));
  const events = parseTranscript(transcript) as unknown as Record<string, unknown>[];
  assert.ok(!events.some((event) => event.subagent === 'toolu_forged'));
});

const replayedSkillLoads = async (
  fixture: string,
  prompt: string,
): Promise<SkillLoadEvent[]> => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-claude-skills-'));
  const root = join(dir, 'repo');
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
        model: MODEL,
        prompt,
        workDir: dir,
        checkout: skillCheckout(root, CLAUDE_SKILL_FILES),
      },
      { stop: new AbortController().signal, rawEvent: () => {}, requestRecord: () => {} },
    )) {
    if (event.type === 'skill_load') loads.push(event);
  }
  return loads;
};

test('given a claude-code worker starting with a skill command and a recording where a subagent invokes another skill, when it runs, then each load is recorded in its own scope with complete coverage', async () => {
  const loads = await replayedSkillLoads('subagents', '/first-skill start the work');

  const final = new Map(
    loads.map((load) => [`${load.subagent ?? ''}:${load.skill}`, load]),
  );
  assert.deepEqual([...final.keys()].sort(), [':first-skill', 'toolu_alpha:other-skill']);
  assert.deepEqual(final.get(':first-skill'), {
    type: 'skill_load',
    skill: 'first-skill',
    source: 'prompt',
    subagent: null,
    coverage: { coveredLines: 8, totalLines: 8 },
  });
  assert.deepEqual(final.get('toolu_alpha:other-skill'), {
    type: 'skill_load',
    skill: 'other-skill',
    source: 'read',
    subagent: 'toolu_alpha',
    coverage: { coveredLines: 8, totalLines: 8 },
  });
});

test('given a claude-code worker on a recording where a request was retried and then succeeded, when its workload runs, then the transcript shows the retry before the recovered response with its attempt, attempts allowed, delay and error, and the run counts one retry', async () => {
  const { code, run, transcript, generations } = await runClaude({ fixture: 'retry' });

  assert.equal(code, 0);
  assert.equal(run.status, 'success');
  const events = parseTranscript(transcript).filter(({ type }) => type !== 'result');
  assert.deepEqual(
    events.map((event) => event.type),
    ['message', 'retry', 'message'],
  );
  const retry = events[1];
  assert.equal(retry?.type, 'retry');
  if (retry?.type === 'retry') {
    assert.equal(retry.attempt, 1);
    assert.equal(retry.maxAttempts, 10);
    assert.equal(typeof retry.delayMs, 'number');
    assert.equal(retry.error, 'overloaded (HTTP 529)');
    assert.equal(retry.subagent, undefined);
  }
  assert.equal(run.counters?.retries, 1);
  assert.deepEqual(
    generations.map(({ generationId }) => generationId),
    ['req_forge_retry_1'],
  );
});

test('given a claude-code worker on a recording where claude compacted its context, when its workload runs, then the transcript shows the compaction where it happened with its trigger and the tokens before and after, and the run counts one compaction', async () => {
  const { code, run, transcript } = await runClaude({ fixture: 'compaction' });

  assert.equal(code, 0);
  assert.equal(run.status, 'success');
  const events = parseTranscript(transcript).filter(({ type }) => type !== 'result');
  assert.deepEqual(
    events.map((event) => event.type),
    ['message', 'message', 'tool_call', 'tool_result', 'compaction', 'message'],
  );
  const compaction = events[4];
  assert.equal(compaction?.type, 'compaction');
  if (compaction?.type === 'compaction') {
    assert.equal(compaction.reason, 'auto');
    assert.equal(compaction.tokensBefore, 190_070);
    assert.equal(compaction.tokensAfter, 824);
    assert.equal(compaction.error, null);
    assert.equal(compaction.subagent, undefined);
  }
  assert.equal(run.counters?.compactions, 1);
});

test('given a claude-code worker on a recording where claude compacted its context, when its workload runs, then the compaction request is a generation with its request id and list-price equivalent, in order, and the run\'s totals include it', async () => {
  const { run, generations, transcript } = await runClaude({ fixture: 'compaction' });

  assert.deepEqual(
    generations.map(({ generationId, subagent, billedCostUsd, estimatedCostUsd }) => [
      generationId,
      subagent,
      billedCostUsd,
      estimatedCostUsd,
    ]),
    [
      ['req_forge_compaction_1', null, null, null],
      ['req_forge_compaction_summary', null, null, null],
      ['req_forge_compaction_2', null, null, null],
    ],
  );
  assert.deepEqual(
    generations.map(({ listPriceEquivalentUsd }) => Number(listPriceEquivalentUsd?.toFixed(9))),
    [
      Number(listPriceOf([500, 40, 189_000, 500]).toFixed(9)),
      Number(listPriceOf([6000, 300, 0, 0]).toFixed(9)),
      Number(listPriceOf([300, 25, 0, 800]).toFixed(9)),
    ],
  );
  assert.equal(run.inputTokens, 6800);
  assert.equal(run.outputTokens, 365);
  assert.equal(run.cacheReadTokens, 189_000);
  assert.equal(run.cacheWriteTokens, 1300);
  const compaction = parseTranscript(transcript).find(({ type }) => type === 'compaction');
  assert.deepEqual(
    compaction?.type === 'compaction'
      ? compaction.calls?.map(({ generationId }) => generationId)
      : undefined,
    ['req_forge_compaction_summary'],
  );
});

test('given a claude-code worker on a recording where a subagent compacted its context, when its workload runs, then the compaction and its generation carry that subagent\'s scope and the parent has none', async () => {
  const { code, run, generations, transcript } = await runClaude({
    fixture: 'subagent-compaction',
  });

  assert.equal(code, 0);
  assert.equal(run.status, 'success');
  const compactions = parseTranscript(transcript).filter(({ type }) => type === 'compaction');
  assert.equal(compactions.length, 1);
  const [compaction] = compactions;
  assert.equal(compaction?.type, 'compaction');
  if (compaction?.type === 'compaction') {
    assert.equal(compaction.subagent, 'toolu_alpha');
    assert.deepEqual(
      compaction.calls?.map(({ generationId }) => generationId),
      ['req_forge_subagent_compaction_summary'],
    );
    assert.equal(compaction.tokensBefore, 6000);
  }
  assert.equal(run.counters?.compactions, 1);
  assert.deepEqual(
    Object.fromEntries(generations.map(({ generationId, subagent }) => [generationId, subagent])),
    {
      req_forge_subagent_compaction_parent_1: null,
      req_forge_subagent_compaction_alpha_1: 'toolu_alpha',
      req_forge_subagent_compaction_summary: 'toolu_alpha',
      req_forge_subagent_compaction_alpha_2: 'toolu_alpha',
      req_forge_subagent_compaction_parent_2: null,
    },
  );
});

const requestsFor = (fixture: string): Record<string, unknown> => {
  const index = readFileSync(
    join(import.meta.dirname, 'fixtures', 'claude-code', fixture, 'bodies', 'index.jsonl'),
    'utf8',
  );
  return Object.fromEntries(
    index
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => [
        (JSON.parse(line) as { request_file: string }).request_file,
        requestBody([{ role: 'user', content: [{ type: 'text', text: 'go' }] }]),
      ]),
  );
};

const requestScopes = (requestRecord: Record<string, unknown>[]): string[] =>
  requestRecord.flatMap((line) =>
    line.type === 'request' ? [String(line.subagent ?? 'parent')] : [],
  );

test('given a claude-code worker on a recording where claude compacted its context and its request bodies were recorded, when its workload runs, then the request record holds one request line per generation, the compaction request included', async () => {
  const { code, requestRecord } = await runClaude({
    fixture: 'compaction',
    requests: requestsFor('compaction'),
  });

  assert.equal(code, 0);
  assert.deepEqual(requestScopes(requestRecord), ['parent', 'parent', 'parent']);
});

test('given a claude-code worker on a recording where a subagent compacted its context and its request bodies were recorded, when its workload runs, then the compaction request is recorded under that subagent\'s scope in generation order', async () => {
  const { code, requestRecord } = await runClaude({
    fixture: 'subagent-compaction',
    requests: requestsFor('subagent-compaction'),
  });

  assert.equal(code, 0);
  assert.deepEqual(requestScopes(requestRecord), [
    'parent',
    'toolu_alpha',
    'toolu_alpha',
    'toolu_alpha',
    'parent',
  ]);
});

test('given a claude-code worker on a recording where a subagent\'s prompt reads like a compaction hand-off, when its workload runs, then the run succeeds and shows no compaction, because a hand-off only follows a turn of the same agent', async () => {
  const { code, run, transcript } = await runClaude({
    fixture: 'subagents',
    rewrite: (stream) =>
      stream.replace(
        '"text":"SUBTASK alpha"',
        '"text":"This session is being continued from a previous conversation that ran out of context."',
      ),
  });

  assert.equal(code, 0);
  assert.equal(run.status, 'success');
  assert.equal(
    parseTranscript(transcript).some(({ type }) => type === 'compaction'),
    false,
  );
  assert.equal(run.counters?.compactions, 0);
});

test('given a claude-code worker on a recording whose stream never announces a compaction request claude recorded, when its workload runs, then the request is still a generation and a compaction in the transcript, so its cost counts toward the budget', async () => {
  const { run, generations, transcript } = await runClaude({
    fixture: 'compaction',
    rewrite: (stream) =>
      stream
        .split('\n')
        .filter(
          (line) =>
            !line.includes('"compact_boundary"') &&
            !line.includes('This session is being continued'),
        )
        .join('\n'),
  });

  assert.equal(run.status, 'success');
  assert.deepEqual(
    generations.map(({ generationId }) => generationId),
    ['req_forge_compaction_1', 'req_forge_compaction_2', 'req_forge_compaction_summary'],
  );
  const compactions = parseTranscript(transcript).filter(({ type }) => type === 'compaction');
  assert.equal(compactions.length, 1);
  assert.equal(run.counters?.compactions, 1);
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

const untilCompaction = (stream: string): string => {
  const lines = stream.split('\n').filter((line) => line !== '');
  const boundary = lines.findIndex((line) => line.includes('"compact_boundary"'));
  return `${lines.slice(0, boundary + 1).join('\n')}\n`;
};

test('given a claude-code worker with a budget its compaction request takes it over and a claude still running, when it runs, then the run is stopped as that request completes and ends exceeded on its budget, with the compaction counted as a generation', async () => {
  const { run, claude, generations, transcript } = await runClaude({
    fixture: 'compaction',
    rewrite: untilCompaction,
    lingerMs: 30_000,
    worker: { maxCostUsd: 0.12 },
  });

  assert.equal(run.status, 'exceeded');
  assert.equal(run.exceededLimit, 'budget');
  assert.equal(isAlive(claude.pid), false);
  assert.deepEqual(
    generations.map(({ generationId }) => generationId),
    ['req_forge_compaction_1', 'req_forge_compaction_summary'],
  );
  assert.ok(
    parseTranscript(transcript).some(({ type }) => type === 'compaction'),
    'the compaction is in the transcript',
  );
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

test('given a claude-code workload, when it runs, then claude is told through its command-line settings, which a checkout\'s own settings cannot override, to allow subagents one level deep and four at once and to run them to completion before reporting back, with their text forwarded', async () => {
  const { claude } = await runClaude({ fixture: 'success' });

  const { argv } = claude;
  const settings = JSON.parse(argv[argv.indexOf('--settings') + 1] ?? '') as {
    env: Record<string, string>;
  };
  assert.deepEqual(settings.env, {
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '4',
  });
  assert.ok(argv.includes('--forward-subagent-text'));
});

test('given a claude-code workload, when it runs, then claude is told through its command-line settings to add no commit or pull request attribution', async () => {
  const { claude } = await runClaude({ fixture: 'success' });

  const { argv } = claude;
  const settings = JSON.parse(argv[argv.indexOf('--settings') + 1] ?? '') as {
    attribution: unknown;
  };
  assert.deepEqual(settings.attribution, { commit: '', pr: '' });
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
