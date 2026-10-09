import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import {
  canonicalHash,
  fingerprintHash,
  sha256,
  parseTranscript,
  rawEventsRef,
  requestRecordRef,
  Store,
  type GenerationRecord,
  type MessageEvent,
  type RunRecord,
} from '@forge/shared';
import { createApp, FileTranscriptSource } from '@forge/frontend';
import type { WorkerConfig } from '../src/index.ts';
import {
  billedAt,
  fakeOpenRouter,
  journaled,
  LISTED_MODELS,
  PI_CONTRACT,
  PI_EXTENSIONS,
  writeFakeBwrap,
  writeFakePi,
  type BwrapCall,
  type GenerationStats,
  type Lookup,
} from './helpers.ts';
import { ANTHROPIC_TOKEN } from './fixtures/fake-provider.ts';
import { main as bill } from '../src/billing-main.ts';
import { NARRATION_INSTRUCTION } from '../src/harness.ts';
import { main } from '../src/main.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'pi');

const fixture = (name: string): string => join(FIXTURES, name);

const {
  subagent: EXTENSION,
  modelDefaultReasoning: REASONING_EXTENSION,
  requestRecord: REQUEST_RECORD_EXTENSION,
} = PI_EXTENSIONS;

const OPERATOR_EXTRAS = ['--skill', '/opt/forge/skills/review'];

const RUNNER_HOME = '/var/empty';

const BILLED_BY_ID = {
  'gen-success-1': 0.0125,
  'gen-success-2': 0.0375,
  'gen-tools-1': 0.01,
  'gen-tools-2': 0.02,
  'gen-tools-3': 0.04,
  'gen-retry-1': 0.002,
  'gen-retry-2': 0.004,
  'gen-subagents-1': 0.5,
  'gen-subagents-2': 0.25,
  'gen-child-alpha-1': 0.125,
  'gen-child-alpha-2': 0.0625,
  'gen-child-beta-1': 0.03125,
};

const billed = billedAt(BILLED_BY_ID);

const OPENROUTER_KEY = 'sk-or-test';

const jsonLines = (contents: string): Record<string, unknown>[] =>
  contents
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

interface Scenario {
  output: string;
  requests?: string;
  openRouterBaseUrl?: string;
  openRouterKey?: string;
  anthropicToken?: string;
  worker?: Partial<WorkerConfig>;
  harnessArgs?: string[];
  env?: NodeJS.ProcessEnv;
  stderr?: string;
  exit?: number;
  lingerMs?: number;
  bwrapFailure?: string;
  harness?: 'direct' | 'linked' | 'missing' | 'relative';
  piVersion?: string | null;
  whileRunning?: (stateDir: string) => Promise<void>;
}

interface Outcome {
  code: number;
  stateDir: string;
  run: RunRecord;
  transcript: string;
  rawEvents: Record<string, unknown>[];
  requestRecord: Record<string, unknown>[];
  bwrap: BwrapCall;
  piStarted: boolean;
  openRouterRequests: number;
  pi: {
    argv: string[];
    cwd: string;
    pid: number;
    subagentInvocation: string | undefined;
    agentDir: string | undefined;
    modelsJson: string | null;
    env: Record<string, string>;
  };
}

const withStore = <T>(stateDir: string, read: (store: Store) => T): T => {
  const store = Store.open(join(stateDir, 'forge.db'));
  try {
    return read(store);
  } finally {
    store.close();
  }
};

const storedRun = (stateDir: string, id: string): RunRecord => {
  const run = withStore(stateDir, (store) => store.getRun(id));
  assert.ok(run);
  return run;
};

const storedGenerations = (
  stateDir: string,
  runId: string,
): GenerationRecord[] =>
  withStore(stateDir, (store) => store.listGenerations(runId));

const systemPi = (stateDir: string): string =>
  join(stateDir, 'current-system', 'sw', 'bin', 'pi');

const harnessCommand = (
  stateDir: string,
  fakePi: string,
  harness: Scenario['harness'] = 'direct',
): string => {
  switch (harness) {
    case 'direct':
      return fakePi;
    case 'linked':
      mkdirSync(dirname(systemPi(stateDir)), { recursive: true });
      symlinkSync(fakePi, systemPi(stateDir));
      return systemPi(stateDir);
    case 'missing':
      return systemPi(stateDir);
    case 'relative':
      return 'pi';
  }
};

const PI_CATALOG_PRICE = {
  input: 4,
  output: 20,
  cacheRead: 0.4,
  cacheWrite: 5,
};

const writeFakePiPackage = (dir: string): string => {
  const providers = join(
    dir,
    'pi-package',
    'node_modules',
    '@earendil-works',
    'pi-ai',
    'dist',
    'providers',
  );
  mkdirSync(providers, { recursive: true });
  writeFileSync(
    join(providers, 'anthropic.models.js'),
    `export const ANTHROPIC_MODELS = ${JSON.stringify({
      'claude-opus-5-5': {
        id: 'claude-opus-5-5',
        cost: PI_CATALOG_PRICE,
        contextWindow: 200000,
        maxTokens: 64000,
      },
    })};\n`,
  );
  return join(dir, 'pi-package');
};

const runWorker = async (scenario: Scenario): Promise<Outcome> => {
  const stateDir = mkdtempSync(join(tmpdir(), 'forge-main-'));
  const fakePi = writeFakePi(stateDir, scenario.piVersion);
  const record = join(stateDir, 'pi-call.json');
  const bwrapRecord = join(stateDir, 'bwrap-call.json');
  const fakeBwrap = writeFakeBwrap(stateDir, {
    record: bwrapRecord,
    harnessEnv: {
      FAKE_PI_RECORD: record,
      FAKE_PI_OUTPUT: scenario.output,
      FAKE_PI_EXIT: String(scenario.exit ?? 0),
      ...(scenario.requests === undefined
        ? {}
        : { FAKE_PI_REQUESTS: scenario.requests }),
      ...(scenario.stderr === undefined
        ? {}
        : { FAKE_PI_STDERR: scenario.stderr }),
      ...(scenario.lingerMs === undefined
        ? {}
        : { FAKE_PI_LINGER_MS: String(scenario.lingerMs) }),
    },
    ...(scenario.bwrapFailure === undefined
      ? {}
      : { failure: scenario.bwrapFailure }),
  });

  const configPath = join(stateDir, 'runtime.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      harnesses: {
        pi: {
          command: harnessCommand(stateDir, fakePi, scenario.harness),
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
      dispatch: {
        gitIdentity: { name: 'Forge Operator', email: 'operator@example.com' },
      },
    }),
  );

  const unlisted =
    scenario.openRouterBaseUrl === undefined ? await fakeOpenRouter(billedAt({})) : null;
  let code: number;
  let openRouterRequests = 0;
  try {
    const running = main(['refiner'], {
      OPENROUTER_BASE_URL: scenario.openRouterBaseUrl ?? unlisted?.baseUrl,
      OPENROUTER_API_KEY: scenario.openRouterKey ?? OPENROUTER_KEY,
      ...(scenario.anthropicToken === undefined
        ? {}
        : { ANTHROPIC_OAUTH_TOKEN: scenario.anthropicToken }),
      HOME: RUNNER_HOME,
      FORGE_RUNTIME_CONFIG: configPath,
      FORGE_STATE_DIR: stateDir,
      FORGE_PI_SUBAGENT_EXTENSION: EXTENSION,
      FORGE_PI_MODEL_DEFAULT_REASONING_EXTENSION: REASONING_EXTENSION,
      FORGE_PI_REQUEST_RECORD_EXTENSION: REQUEST_RECORD_EXTENSION,
      FORGE_BWRAP: fakeBwrap,
      FORGE_PI_PACKAGE: writeFakePiPackage(stateDir),
      ...scenario.env,
    });
    await scenario.whileRunning?.(stateDir);
    code = await running;
  } finally {
    openRouterRequests =
      (unlisted?.modelRequests ?? 0) + (unlisted?.lookups.length ?? 0);
    unlisted?.close();
  }

  const runs = withStore(stateDir, (store) => store.listRuns());
  assert.equal(runs.length, 1);
  const runId = (runs[0] as RunRecord).id;

  return {
    code,
    stateDir,
    run: storedRun(stateDir, runId),
    transcript: readFileSync(
      join(stateDir, 'transcripts', `${runId}.jsonl`),
      'utf8',
    ),
    get rawEvents() {
      return jsonLines(
        readFileSync(
          join(stateDir, 'transcripts', rawEventsRef(runId)),
          'utf8',
        ),
      );
    },
    get requestRecord() {
      return jsonLines(
        readFileSync(
          join(stateDir, 'transcripts', requestRecordRef(runId)),
          'utf8',
        ),
      );
    },
    get bwrap() {
      return JSON.parse(readFileSync(bwrapRecord, 'utf8')) as BwrapCall;
    },
    piStarted: existsSync(record),
    openRouterRequests,
    get pi() {
      return JSON.parse(readFileSync(record, 'utf8')) as Outcome['pi'];
    },
  };
};

const fire = (
  stateDir: string,
  openRouter: { baseUrl: string },
  env: NodeJS.ProcessEnv = {},
): Promise<number> =>
  bill({
    FORGE_STATE_DIR: stateDir,
    OPENROUTER_BASE_URL: openRouter.baseUrl,
    OPENROUTER_API_KEY: OPENROUTER_KEY,
    ...env,
  });

const settled = async (
  scenario: Scenario,
  generations: GenerationStats = billed,
): Promise<Outcome & { lookups: Lookup[] }> => {
  const openRouter = await fakeOpenRouter(generations);
  try {
    const outcome = await runWorker(scenario);
    assert.equal(await fire(outcome.stateDir, openRouter), 0);
    return {
      ...outcome,
      run: storedRun(outcome.stateDir, outcome.run.id),
      lookups: openRouter.lookups,
    };
  } finally {
    openRouter.close();
  }
};

const generationsRecorded = async (
  stateDir: string,
  count: number,
): Promise<RunRecord> => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const run = withStore(stateDir, (store) => store.listRuns()[0]);
    if (run !== undefined && storedGenerations(stateDir, run.id).length >= count) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`the run did not record ${count} generations within 5 seconds`);
};

const assertCost = (actual: number | null | undefined, expected: number): void => {
  assert.ok(
    typeof actual === 'number' && Math.abs(actual - expected) < 1e-12,
    `expected a cost of ${expected}, got ${actual}`,
  );
};

const estimateAt = (
  model: string,
  [input, output, cacheRead, cacheWrite]: [number, number, number, number],
): number => {
  const pricing: Record<string, string | undefined> =
    LISTED_MODELS.data.find(({ id }) => id === model)?.pricing ?? {};
  return (
    input * Number(pricing.prompt) +
    output * Number(pricing.completion) +
    cacheRead * Number(pricing.input_cache_read ?? 0) +
    cacheWrite * Number(pricing.input_cache_write ?? 0)
  );
};

const FIRST_ESTIMATE = estimateAt('z-ai/glm-5', [200, 40, 0, 1000]);

const SECOND_ESTIMATE = estimateAt('z-ai/glm-5', [100, 25, 1000, 200]);

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

const withoutGenerationId = (name: string, id: string): string =>
  outputFile(
    readFileSync(fixture(name), 'utf8')
      .split('\n')
      .map((line) =>
        line.includes('"type":"message_end"')
          ? line.replace(`,"responseId":"${id}"`, '')
          : line,
      )
      .join('\n'),
  );

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

const dashboardCost = async (stateDir: string): Promise<string> => {
  const store = Store.open(join(stateDir, 'forge.db'));
  try {
    const app = createApp({
      store,
      transcripts: new FileTranscriptSource(join(stateDir, 'transcripts')),
      css: '',
      logo: '',
      idiomorph: '',
      client: '',
    });
    const body = await (await app.request('/')).text();
    return (body.match(/<td[^>]*\sdata-cost(?=[\s>])[^>]*>([\s\S]*?)<\/td>/)?.[1] ?? '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } finally {
    store.close();
  }
};

test('given recorded pi output of a successful multi-message run with tool, turn and streaming events, when the worker runs, then the events forge does not consume are skipped and the run is success with its usage summed with the cache split, the session id, and a readable transcript', async () => {
  const output = fixture('success.jsonl');

  const { code, run, transcript } = await runWorker({ output });

  assert.equal(code, 0);
  assert.equal(run.status, 'success');
  assert.equal(run.error, null);
  assert.equal(run.inputTokens, 200 + 100);
  assert.equal(run.outputTokens, 40 + 25);
  assert.equal(run.cacheReadTokens, 0 + 1000);
  assert.equal(run.cacheWriteTokens, 1000 + 200);
  assert.equal(run.sessionId, sessionIdOf(output));
  assert.match(transcript, /Let me look\./);
  assert.match(transcript, /The command printed forge\. All done\./);
});

test('given recorded pi output whose assistant turns think before and after their text, when the transcript is read, then the prompt carries the run start as its time, and each assistant message its time, its thinking, its stop reason and its cache-split usage', async () => {
  const { run, transcript } = await runWorker({ output: fixture('success.jsonl') });

  const messages = parseTranscript(transcript).filter(
    (event): event is MessageEvent => event.type === 'message',
  );
  assert.deepEqual(
    messages.map(({ role, text, thinking, timestamp, stopReason, usage }) => ({
      role,
      text,
      thinking,
      timestamp,
      stopReason,
      usage,
    })),
    [
      {
        role: 'user',
        text: 'refine the spec',
        thinking: undefined,
        timestamp: run.startTime,
        stopReason: undefined,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      {
        role: 'assistant',
        text: 'Let me look.',
        thinking: 'I should run the command and read what it prints.',
        timestamp: '2026-10-03T11:30:58.077Z',
        stopReason: 'toolUse',
        usage: { inputTokens: 200, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 1000 },
      },
      {
        role: 'assistant',
        text: 'The command printed forge. All done.',
        thinking: 'The output is forge, so I can report it.',
        timestamp: '2026-10-03T11:30:58.102Z',
        stopReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 25, cacheReadTokens: 1000, cacheWriteTokens: 200 },
      },
    ],
  );
});

test('given recorded pi output where pi retried a response that failed, with the OpenRouter key in the provider error and in the retry\'s thinking, when the transcript is read, then the failed message with its stop reason and error, the retry with its attempt, attempts allowed, delay and error, and the recovered message with its thinking follow each other, the key redacted throughout', async () => {
  const { transcript } = await runWorker({
    output: outputFile(
      readFileSync(fixture('retry.jsonl'), 'utf8')
        .replaceAll('Provider returned error', `Provider returned error for ${OPENROUTER_KEY}`)
        .replaceAll(
          '"thinking":"The first attempt failed, so I will answer directly."',
          `"thinking":"The first attempt failed for ${OPENROUTER_KEY}."`,
        ),
    ),
  });

  const events = parseTranscript(transcript).filter((event) => event.type !== 'result');
  assert.deepEqual(
    events.slice(1).map((event) =>
      event.type === 'message'
        ? { text: event.text, thinking: event.thinking, stopReason: event.stopReason, error: event.error }
        : event,
    ),
    [
      { text: 'Starting', thinking: undefined, stopReason: 'error', error: 'Provider returned error for [redacted]' },
      { type: 'retry', attempt: 1, maxAttempts: 3, delayMs: 2000, error: 'Provider returned error for [redacted]' },
      { text: 'Recovered and finished.', thinking: 'The first attempt failed for [redacted].', stopReason: 'stop', error: undefined },
    ],
  );
  assert.doesNotMatch(transcript, new RegExp(OPENROUTER_KEY));
});

test('given recorded pi output where pi compacted its context after a tool call, with the OpenRouter key in the summary, when the transcript is read, then a compaction with its reason, tokens before and after and redacted summary sits between the tool result and the next message', async () => {
  const { transcript } = await runWorker({
    output: outputFile(
      readFileSync(fixture('compaction.jsonl'), 'utf8').replaceAll(
        'No prior history.',
        `No prior history for ${OPENROUTER_KEY}.`,
      ),
    ),
  });

  const events = parseTranscript(transcript).filter((event) => event.type !== 'result');
  assert.deepEqual(
    events.slice(1).map((event) => (event.type === 'message' ? event.text : event.type === 'compaction' ? event : event.type)),
    [
      'Let me look.',
      'tool_call',
      'tool_result',
      {
        type: 'compaction',
        reason: 'threshold',
        tokensBefore: 190032,
        tokensAfter: 1694,
        summary: 'No prior history for [redacted].\n\n---\n\n**Turn Context (split turn):**\n\n## GoalRun echo forge and report what it printed.',
        error: null,
      },
      'The command printed forge.',
    ],
  );
});

for (const [given, end, error] of [
  ['was aborted', { aborted: true }, 'compaction was aborted'],
  ['failed with the OpenRouter key in its error', { aborted: false, errorMessage: `summary failed for ${OPENROUTER_KEY}` }, 'summary failed for [redacted]'],
] as const) {
  test(`given recorded pi output where a compaction ${given}, when the transcript is read, then the compaction carries no summary and says why`, async () => {
    const { transcript } = await runWorker({
      output: outputFile(
        readFileSync(fixture('compaction.jsonl'), 'utf8')
          .split('\n')
          .map((line) =>
            line.startsWith('{"type":"compaction_end"')
              ? JSON.stringify({ type: 'compaction_end', reason: 'overflow', willRetry: false, ...end })
              : line,
          )
          .join('\n'),
      ),
    });

    const compaction = parseTranscript(transcript).find((event) => event.type === 'compaction');
    assert.deepEqual(compaction, {
      type: 'compaction',
      reason: 'overflow',
      tokensBefore: null,
      tokensAfter: null,
      summary: null,
      error,
    });
  });
}

test('given recorded pi output where a subagent retried a response and compacted its context, when the transcript is read, then that retry and compaction carry the subagent scope', async () => {
  const childEvent = (name: string, type: string): string =>
    readFileSync(fixture(name), 'utf8')
      .split('\n')
      .find((line) => line.startsWith(`{"type":"${type}"`)) ?? assert.fail(`${name} has no ${type}`);
  const wrapped = (event: string): string =>
    `{"type":"tool_execution_update","toolCallId":"call_alpha","toolName":"subagent","args":{"task":"Run echo alpha and report what it printed."},"partialResult":{"content":[],"details":{"event":${event}}}}`;
  const lines = readFileSync(fixture('subagents.jsonl'), 'utf8').split('\n');
  const started = lines.findIndex((line) => line === wrapped('{"type":"agent_start"}'));
  assert.ok(started > 0);
  lines.splice(
    started + 1,
    0,
    wrapped(childEvent('retry.jsonl', 'auto_retry_start')),
    wrapped(childEvent('compaction.jsonl', 'compaction_end')),
  );

  const { transcript } = await runWorker({ output: outputFile(lines.join('\n')) });

  const scoped = parseTranscript(transcript).flatMap((event) =>
    event.type === 'retry' || event.type === 'compaction' ? [[event.type, event.subagent]] : [],
  );
  assert.deepEqual(scoped, [
    ['retry', 'call_alpha'],
    ['compaction', 'call_alpha'],
  ]);
});

test('given pi output whose stop reason and compaction reason carry the OpenRouter key, when the transcript is read, then both are redacted', async () => {
  const { transcript } = await runWorker({
    output: outputFile(
      readFileSync(fixture('compaction.jsonl'), 'utf8')
        .replaceAll('"stopReason":"toolUse"', `"stopReason":"toolUse ${OPENROUTER_KEY}"`)
        .replaceAll('"reason":"threshold"', `"reason":"threshold ${OPENROUTER_KEY}"`),
    ),
  });

  const events = parseTranscript(transcript);
  const stopReasons = events.flatMap((event) => (event.type === 'message' && event.stopReason !== undefined ? [event.stopReason] : []));
  const reasons = events.flatMap((event) => (event.type === 'compaction' ? [event.reason] : []));
  assert.deepEqual(stopReasons, ['toolUse [redacted]', 'stop']);
  assert.deepEqual(reasons, ['threshold [redacted]']);
});

test('given pi output whose assistant messages carry a time out of range or not a number and a stop reason that is not a string, when the worker runs, then the run succeeds and those messages are recorded without them', async () => {
  const { run, transcript } = await runWorker({
    output: outputFile(
      readFileSync(fixture('success.jsonl'), 'utf8')
        .replaceAll('"timestamp":1791027058077', '"timestamp":1e20')
        .replaceAll('"timestamp":1791027058102', '"timestamp":"soon"')
        .replaceAll('"stopReason":"toolUse"', '"stopReason":7'),
    ),
  });

  assert.equal(run.status, 'success');
  const assistant = parseTranscript(transcript).filter(
    (event): event is MessageEvent => event.type === 'message' && event.role === 'assistant',
  );
  assert.deepEqual(
    assistant.map(({ text, timestamp, stopReason }) => ({ text, timestamp, stopReason })),
    [
      { text: 'Let me look.', timestamp: undefined, stopReason: undefined },
      { text: 'The command printed forge. All done.', timestamp: undefined, stopReason: 'stop' },
    ],
  );
});

test('given a workload whose pi has completed two generations with cache reads and writes, when the store is read before the workload ends, then each generation carries its four token counts from pi and the workload totals are their sum', async () => {
  let live: { run: RunRecord; generations: GenerationRecord[] } | undefined;

  await runWorker({
    output: cutBefore('success.jsonl', 'agent_end'),
    lingerMs: 1000,
    whileRunning: async (stateDir) => {
      const run = await generationsRecorded(stateDir, 2);
      live = { run, generations: storedGenerations(stateDir, run.id) };
    },
  });

  assert.ok(live);
  assert.equal(live.run.endTime, null);
  assert.deepEqual(
    live.generations.map(({ generationId, usage }) => ({ generationId, usage })),
    [
      {
        generationId: 'gen-success-1',
        usage: { inputTokens: 200, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 1000 },
      },
      {
        generationId: 'gen-success-2',
        usage: { inputTokens: 100, outputTokens: 25, cacheReadTokens: 1000, cacheWriteTokens: 200 },
      },
    ],
  );
  assert.deepEqual(
    {
      inputTokens: live.run.inputTokens,
      outputTokens: live.run.outputTokens,
      cacheReadTokens: live.run.cacheReadTokens,
      cacheWriteTokens: live.run.cacheWriteTokens,
    },
    { inputTokens: 300, outputTokens: 65, cacheReadTokens: 1000, cacheWriteTokens: 1200 },
  );
});

test('given the models endpoint lists the worker\'s model at known prices and pi has completed two generations with known token counts, when the store is read before billing runs, then the workload records the list price, each generation\'s estimated cost is its tokens at those prices, and the workload is shown as estimated at their sum', async () => {
  const openRouter = await fakeOpenRouter(billedAt({}), LISTED_MODELS);
  let live: { run: RunRecord; generations: GenerationRecord[] } | undefined;
  try {
    await runWorker({
      output: cutBefore('success.jsonl', 'agent_end'),
      openRouterBaseUrl: openRouter.baseUrl,
      lingerMs: 1000,
      whileRunning: async (stateDir) => {
        const run = await generationsRecorded(stateDir, 2);
        live = { run: storedRun(stateDir, run.id), generations: storedGenerations(stateDir, run.id) };
      },
    });
  } finally {
    openRouter.close();
  }

  assert.ok(live);
  const estimates = live.generations.map(({ estimatedCostUsd }) => estimatedCostUsd);
  assert.equal(estimates.length, 2);
  assertCost(estimates[0], FIRST_ESTIMATE);
  assertCost(estimates[1], SECOND_ESTIMATE);
  assert.deepEqual(live.run.listPrice, { input: 0.000002, output: 0.00001, cacheRead: 0.0000002, cacheWrite: 0.0000025 });
  assert.equal(live.run.costStatus, 'pending');
  assert.equal(live.run.costEstimated, true);
  assertCost(live.run.costUsd, FIRST_ESTIMATE + SECOND_ESTIMATE);
  assert.equal(openRouter.modelRequests, 1);
});

test('given a finished workload whose two generations carry estimated costs, when billing settles the first and later the second, then each billed generation\'s cost is its billed cost with no estimate left, and the workload stays estimated until every generation is billed', async () => {
  const openRouter = await fakeOpenRouter(
    (id, attempt) => (id === 'gen-success-2' && attempt === 1 ? { status: 404 } : billed(id, attempt)),
    LISTED_MODELS,
  );
  try {
    const { stateDir, run } = await runWorker({
      output: fixture('success.jsonl'),
      openRouterBaseUrl: openRouter.baseUrl,
    });
    assert.equal(await fire(stateDir, openRouter), 0);
    const partly = storedRun(stateDir, run.id);
    assert.equal(partly.costStatus, 'pending');
    assert.equal(partly.costEstimated, true);
    assertCost(partly.costUsd, 0.0125 + SECOND_ESTIMATE);
    assert.equal(storedGenerations(stateDir, run.id)[0]?.estimatedCostUsd, null);

    assert.equal(await fire(stateDir, openRouter), 0);
    const settled = storedRun(stateDir, run.id);
    assert.equal(settled.costStatus, 'billed');
    assert.equal(settled.costEstimated, false);
    assert.equal(settled.costUsd, 0.0125 + 0.0375);
    assert.deepEqual(
      storedGenerations(stateDir, run.id).map(({ estimatedCostUsd, billedCostUsd }) => ({ estimatedCostUsd, billedCostUsd })),
      [
        { estimatedCostUsd: null, billedCostUsd: 0.0125 },
        { estimatedCostUsd: null, billedCostUsd: 0.0375 },
      ],
    );
  } finally {
    openRouter.close();
  }
});

test('given the models endpoint lists the worker\'s model with no cache prices, when a generation without cache tokens and one with them complete, then the first has an estimated cost at the listed prices, the second has none rather than a guess, and the workload is not shown as estimated since its estimate would leave the second out', async () => {
  const output = outputFile(
    readFileSync(fixture('success.jsonl'), 'utf8').replaceAll(
      '"usage":{"input":200,"output":40,"cacheRead":0,"cacheWrite":1000',
      '"usage":{"input":200,"output":40,"cacheRead":0,"cacheWrite":0',
    ),
  );
  const openRouter = await fakeOpenRouter(billedAt({}), LISTED_MODELS);
  try {
    const { stateDir, run } = await runWorker({
      output,
      openRouterBaseUrl: openRouter.baseUrl,
      worker: { model: 'z-ai/glm-4.6' },
    });

    const [first, second] = storedGenerations(stateDir, run.id);
    assertCost(first?.estimatedCostUsd, estimateAt('z-ai/glm-4.6', [200, 40, 0, 0]));
    assert.equal(second?.estimatedCostUsd, null);
    assert.equal(run.costEstimated, false);
    assert.equal(run.costUsd, 0);
  } finally {
    openRouter.close();
  }
});

test('given a listed model and pi output where one response used tokens but carries no generation id, when the workload runs and billing later settles the other, then the response forge gave up on adds no estimate, the workload is estimated only while the other awaits billing, and ends unconfirmed at what was billed', async () => {
  const openRouter = await fakeOpenRouter(billed, LISTED_MODELS);
  try {
    const { stateDir, run } = await journaled(async () =>
      runWorker({
        output: withoutGenerationId('success.jsonl', 'gen-success-2'),
        openRouterBaseUrl: openRouter.baseUrl,
      }),
    ).then(({ result }) => result);

    assert.equal(run.costStatus, 'unconfirmed');
    assert.equal(run.costEstimated, true);
    assertCost(run.costUsd, FIRST_ESTIMATE);

    assert.equal(await fire(stateDir, openRouter), 0);
    const settled = storedRun(stateDir, run.id);
    assert.equal(settled.costStatus, 'unconfirmed');
    assert.equal(settled.costEstimated, false);
    assert.equal(settled.costUsd, 0.0125);
  } finally {
    openRouter.close();
  }
});

test('given the models endpoint lists the worker\'s model at a price so large its estimate overflows, when a generation completes, then it has no estimated cost and the workload is not shown as estimated', async () => {
  const openRouter = await fakeOpenRouter(billedAt({}), {
    data: [{ id: 'z-ai/glm-5', pricing: { prompt: '1e308', completion: '1e308', input_cache_read: '1e308', input_cache_write: '1e308' } }],
  });
  try {
    const { stateDir, run } = await runWorker({ output: fixture('success.jsonl'), openRouterBaseUrl: openRouter.baseUrl });

    assert.deepEqual(storedGenerations(stateDir, run.id).map(({ estimatedCostUsd }) => estimatedCostUsd), [null, null]);
    assert.equal(run.costEstimated, false);
    assert.equal(run.costUsd, 0);
  } finally {
    openRouter.close();
  }
});

test('given the models endpoint is unavailable, or lists other models but not the worker\'s, when the workload runs and its generations complete, then it still succeeds, its generations have tokens but no estimated cost, pi starts with an agent dir that has no models.json, and the journal says why', async () => {
  for (const [models, reason] of [
    [null, /HTTP 404/],
    [{ data: [{ id: 'z-ai/glm-4.6', pricing: { prompt: '0.0000006', completion: '0.0000022' } }] }, /not listed/],
  ] as const) {
    const openRouter = await fakeOpenRouter(billedAt({}), models);
    try {
      const { result, journal } = await journaled(() =>
        runWorker({ output: fixture('success.jsonl'), openRouterBaseUrl: openRouter.baseUrl }),
      );

      assert.equal(result.code, 0);
      assert.equal(result.run.status, 'success');
      assert.equal(result.run.listPrice, null);
      assert.equal(result.run.costEstimated, false);
      assert.equal(result.run.costUsd, 0);
      const generations = storedGenerations(result.stateDir, result.run.id);
      assert.equal(generations.length, 2);
      for (const generation of generations) {
        assert.notEqual(generation.usage, null);
        assert.equal(generation.estimatedCostUsd, null);
      }
      assert.match(journal, /could not look up OpenRouter's models entry for z-ai\/glm-5/);
      assert.ok(result.pi.agentDir);
      assert.equal(result.pi.modelsJson, null);
      assert.match(journal, reason);
    } finally {
      openRouter.close();
    }
  }
});

test('given pi reports its own cost for each generation, when the store and the dashboard are read before billing, then the workload\'s cost is forge\'s estimate and pi\'s figure appears in neither', async () => {
  const output = outputFile(
    readFileSync(fixture('success.jsonl'), 'utf8').replace(/"total":[0-9.e-]+/g, '"total":0.4242'),
  );
  const openRouter = await fakeOpenRouter(billedAt({}), LISTED_MODELS);
  try {
    const { stateDir, run } = await runWorker({ output, openRouterBaseUrl: openRouter.baseUrl });

    assertCost(run.costUsd, FIRST_ESTIMATE + SECOND_ESTIMATE);
    const stored = JSON.stringify(
      withStore(stateDir, (store) => [store.listRuns(), store.listGenerations(run.id)]),
    );
    assert.doesNotMatch(stored, /0\.4242|0\.8484/);
    const store = Store.open(join(stateDir, 'forge.db'));
    try {
      const app = createApp({
        store,
        transcripts: new FileTranscriptSource(join(stateDir, 'transcripts')),
        css: '',
        logo: '',
        idiomorph: '',
        client: '',
      });
      for (const page of ['/', `/runs/${run.id}`]) {
        assert.doesNotMatch(await (await app.request(page)).text(), /0\.4242|0\.8484/);
      }
    } finally {
      store.close();
    }
  } finally {
    openRouter.close();
  }
});

test('given pi output whose usage counts are too large to read back, negative, fractional or not numbers, when the worker runs, then those counts are recorded as 0, the valid counts still sum, and the dashboard still lists and shows the run', async () => {
  const output = outputFile(
    readFileSync(fixture('success.jsonl'), 'utf8')
      .split('\n')
      .map((line) =>
        line.includes('"type":"message_end"') && line.includes('"responseId":"gen-success-1"')
          ? line.replace(
              /"usage":\{"input":\d+,"output":\d+,"cacheRead":\d+,"cacheWrite":\d+/,
              '"usage":{"input":1152921504606846976,"output":-40,"cacheRead":1.5,"cacheWrite":"1000"',
            )
          : line,
      )
      .join('\n'),
  );

  const { stateDir, run } = await runWorker({ output });

  assert.deepEqual(
    storedGenerations(stateDir, run.id).map(({ usage }) => usage),
    [
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { inputTokens: 100, outputTokens: 25, cacheReadTokens: 1000, cacheWriteTokens: 200 },
    ],
  );
  assert.equal(run.inputTokens, 100);
  const store = Store.open(join(stateDir, 'forge.db'));
  try {
    const app = createApp({
      store,
      transcripts: new FileTranscriptSource(join(stateDir, 'transcripts')),
      css: '',
      logo: '',
      idiomorph: '',
      client: '',
    });
    assert.equal((await app.request('/')).status, 200);
    assert.equal((await app.request(`/runs/${run.id}`)).status, 200);
  } finally {
    store.close();
  }
});

test('given a recorded run with two parallel subagent calls, when the transcript is written, then each child message carries its subagent scope and the parent messages carry none', async () => {
  const { transcript } = await runWorker({
    output: fixture('subagents.jsonl'),
  });

  const messages = parseTranscript(transcript).slice(1).filter(
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

test('given a pi stream with three tool calls one of which failed, a retry and a compaction, when the workload ends, then its counters match them', async () => {
  const { run } = await runWorker({
    output: outputFile(
      ['tool-calls.jsonl', 'retry.jsonl', 'compaction.jsonl']
        .map((name) => readFileSync(fixture(name), 'utf8'))
        .join('\n'),
    ),
  });

  assert.deepEqual(run.counters, {
    toolCalls: 3,
    failedToolResults: 1,
    retries: 1,
    compactions: 1,
  });
});

test('given an older workload recorded without counters whose transcript ends in a line cut off mid-write, when billing runs twice, then the first run fills its counters from the complete lines and the second leaves them unchanged', async () => {
  const openRouter = await fakeOpenRouter(billed);
  try {
    const { stateDir, run } = await runWorker({ output: fixture('tool-calls.jsonl') });
    const database = new DatabaseSync(join(stateDir, 'forge.db'));
    database.exec(
      'UPDATE runs SET tool_calls = NULL, failed_tool_results = NULL, retries = NULL, compactions = NULL',
    );
    database.close();
    appendFileSync(join(stateDir, 'transcripts', `${run.id}.jsonl`), '{"type":"tool_ca');

    assert.equal(await fire(stateDir, openRouter), 0);
    const filled = storedRun(stateDir, run.id).counters;
    assert.equal(await fire(stateDir, openRouter), 0);

    assert.deepEqual(filled, { toolCalls: 2, failedToolResults: 1, retries: 0, compactions: 0 });
    assert.deepEqual(storedRun(stateDir, run.id).counters, filled);
  } finally {
    openRouter.close();
  }
});

test('given an older workload recorded without counters whose transcript ref points outside the transcripts directory, when billing runs, then the file there is not read and the counters stay empty', async () => {
  const openRouter = await fakeOpenRouter(billed);
  try {
    const { stateDir, run } = await runWorker({ output: fixture('tool-calls.jsonl') });
    writeFileSync(
      join(stateDir, 'outside.jsonl'),
      '{"type":"tool_call","id":"x","name":"bash","arguments":{}}\n',
    );
    const database = new DatabaseSync(join(stateDir, 'forge.db'));
    database.exec(
      "UPDATE runs SET tool_calls = NULL, failed_tool_results = NULL, retries = NULL, compactions = NULL, transcript_ref = '../outside.jsonl'",
    );
    database.close();

    assert.equal(await fire(stateDir, openRouter), 0);

    assert.equal(storedRun(stateDir, run.id).counters, null);
  } finally {
    openRouter.close();
  }
});

const numberedLines = (count: number): string =>
  Array.from({ length: count }, (_, index) => `Step ${index + 1}.`).join('\n');

const transcriptLines = (events: Record<string, unknown>[]): string =>
  `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;

const NO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

const FULL_AND_PARTIAL_READS = transcriptLines([
  { type: 'message', role: 'user', text: 'Review the change.', usage: NO_USAGE, generationId: null },
  {
    type: 'tool_call',
    id: 'call_1',
    name: 'read',
    arguments: { path: '.claude/skills/work-on/SKILL.md' },
  },
  { type: 'tool_result', id: 'call_1', isError: false, text: numberedLines(30) },
  {
    type: 'tool_call',
    id: 'call_2',
    name: 'read',
    arguments: { path: '.claude/skills/code-review/SKILL.md', offset: 1, limit: 60 },
  },
  {
    type: 'tool_result',
    id: 'call_2',
    isError: false,
    text: `${numberedLines(60)}\n\n[82 more lines in file. Use offset=61 to continue.]`,
  },
  {
    type: 'tool_call',
    id: 'call_3',
    name: 'read',
    arguments: { path: '.claude/skills/Not_A_Skill/SKILL.md' },
  },
  { type: 'tool_result', id: 'call_3', isError: false, text: numberedLines(5) },
  { type: 'result', status: 'success', sessionId: null, error: null },
]);

const beforeSkillLoads = (stateDir: string, transcript: string, runId: string): void => {
  writeFileSync(join(stateDir, 'transcripts', `${runId}.jsonl`), transcript);
  const database = new DatabaseSync(join(stateDir, 'forge.db'));
  database.exec('DROP TABLE IF EXISTS skill_loads');
  const marked = database
    .prepare("SELECT 1 FROM pragma_table_info('runs') WHERE name = 'skill_loads_recorded'")
    .get();
  if (marked !== undefined) {
    database.exec('ALTER TABLE runs DROP COLUMN skill_loads_recorded');
  }
  database.close();
};

const skillsListed = async (stateDir: string, runId: string): Promise<string[]> =>
  withStore(stateDir, async (store) => {
    const app = createApp({
      store,
      transcripts: new FileTranscriptSource(join(stateDir, 'transcripts')),
      css: '',
      logo: '',
      idiomorph: '',
      client: '',
    });
    const response = await app.request(`/runs/${runId}`);
    assert.equal(response.status, 200);
    const page = await response.text();
    return [...page.matchAll(/<li[^>]*data-skill="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g)].map(
      ([, name = '', item = '']) =>
        [name, ...[...item.matchAll(/data-skill-partial[^>]*>([^<]*)</g)].map(([, badge = '']) => badge.trim())].join(' '),
    );
  });

test('given a store from before skill loads whose run transcript holds a full read and a partial read of two skills, when billing opens the store, then the run page lists both under their directory names with the partial read showing its coverage', async () => {
  const openRouter = await fakeOpenRouter(billed);
  try {
    const { stateDir, run } = await runWorker({ output: fixture('tool-calls.jsonl') });
    beforeSkillLoads(stateDir, FULL_AND_PARTIAL_READS, run.id);

    assert.equal(await fire(stateDir, openRouter), 0);

    assert.deepEqual(await skillsListed(stateDir, run.id), [
      'code-review partial · 60/142',
      'work-on',
    ]);
  } finally {
    openRouter.close();
  }
});

test('given a store already upgraded with skill loads backfilled, when billing opens it again, then no load is recorded twice', async () => {
  const openRouter = await fakeOpenRouter(billed);
  try {
    const { stateDir, run } = await runWorker({ output: fixture('tool-calls.jsonl') });
    beforeSkillLoads(stateDir, FULL_AND_PARTIAL_READS, run.id);
    assert.equal(await fire(stateDir, openRouter), 0);
    const first = withStore(stateDir, (store) => store.listSkillLoads(run.id));
    writeFileSync(join(stateDir, 'transcripts', `${run.id}.jsonl`), transcriptLines([]));

    assert.equal(await fire(stateDir, openRouter), 0);

    assert.equal(first.length, 2);
    assert.deepEqual(withStore(stateDir, (store) => store.listSkillLoads(run.id)), first);
  } finally {
    openRouter.close();
  }
});

test('given a store from before skill loads with a run whose transcript is gone, when billing opens it, then the upgrade completes, the run has no record, and its page still renders', async () => {
  const openRouter = await fakeOpenRouter(billed);
  try {
    const { stateDir, run } = await runWorker({ output: fixture('tool-calls.jsonl') });
    beforeSkillLoads(stateDir, FULL_AND_PARTIAL_READS, run.id);
    rmSync(join(stateDir, 'transcripts', `${run.id}.jsonl`));

    assert.equal(await fire(stateDir, openRouter), 0);

    assert.deepEqual(withStore(stateDir, (store) => store.listSkillLoads(run.id)), []);
    assert.equal(withStore(stateDir, (store) => store.runsWithoutSkillLoadRecord()).length, 0);
    assert.deepEqual(await skillsListed(stateDir, run.id), []);
  } finally {
    openRouter.close();
  }
});

test('given a recorded run whose agent calls bash in turns with no text, one call failing, when the transcript is written, then each call is recorded with its arguments and each result with its output and error flag, in stream order', async () => {
  const { code, run, transcript } = await runWorker({
    output: fixture('tool-calls.jsonl'),
  });

  assert.equal(code, 0);
  assert.equal(run.inputTokens, 1000 + 100 + 100);
  assert.equal(run.cacheReadTokens, 0 + 1000 + 1100);
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

const outputOf = (events: unknown[]): string =>
  outputFile(events.map((event) => `${JSON.stringify(event)}\n`).join(''));

const isStreamed = (event: Record<string, unknown> | undefined): boolean =>
  event?.type === 'message_update' ||
  (event?.type === 'tool_execution_update' && event.toolName !== 'subagent');

const forwardedBy = (event: Record<string, unknown>): Record<string, unknown> | undefined =>
  (event as { partialResult?: { details?: { event?: Record<string, unknown> } } })
    .partialResult?.details?.event;

const withoutStreaming = (events: Record<string, unknown>[]): Record<string, unknown>[] =>
  events.filter((event) => !isStreamed(event) && !isStreamed(forwardedBy(event)));

const bashResult = (text: string) => ({
  type: 'tool_execution_end',
  toolCallId: 'call_1',
  toolName: 'bash',
  result: { content: [{ type: 'text', text }] },
  isError: false,
});

test('given a pi stream with streaming deltas, a retry, thinking and a tool result over the transcript cap holding the OpenRouter key, when the workload ends, then its raw events hold every event but the streaming deltas and tool progress, with the key redacted and the tool result kept whole', async () => {
  const output = (key: string): string =>
    `OPENROUTER_API_KEY=${key}\n${'a'.repeat(40 * 1024)}`;
  const events = jsonLines(readFileSync(fixture('retry.jsonl'), 'utf8'));
  const end = events.findLastIndex((event) => event.type === 'agent_end');
  const withResult = (text: string): Record<string, unknown>[] => [
    ...events.slice(0, end),
    bashResult(text),
    ...events.slice(end),
  ];

  const { rawEvents } = await runWorker({
    output: outputOf(withResult(output(OPENROUTER_KEY))),
  });

  assert.deepEqual(rawEvents, withoutStreaming(withResult(output('[redacted]'))));
});

test('given a workload whose agent spawned two subagents that ran a tool, when the workload ends, then its raw events hold every event of the parent and each child but their streaming deltas and tool progress', async () => {
  const events = jsonLines(readFileSync(fixture('subagents.jsonl'), 'utf8'));

  const { rawEvents } = await runWorker({ output: fixture('subagents.jsonl') });

  assert.equal(events.length - rawEvents.length, 16 + 17 + 2);
  assert.deepEqual(rawEvents, withoutStreaming(events));
});

const rawEventsOnceWritten = async (
  stateDir: string,
  count: number,
): Promise<{ run: RunRecord; rawEvents: Record<string, unknown>[] }> => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const run = withStore(stateDir, (store) => store.listRuns()[0]);
    const path =
      run === undefined
        ? undefined
        : join(stateDir, 'transcripts', rawEventsRef(run.id));
    const rawEvents =
      path !== undefined && existsSync(path)
        ? jsonLines(readFileSync(path, 'utf8'))
        : [];
    if (run !== undefined && rawEvents.length >= count) {
      return { run, rawEvents };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`the run did not write ${count} raw events within 5 seconds`);
};

test('given a workload whose pi dies mid-run, when its raw events are read while pi is still alive and after it has died, then they hold every event pi emitted up to that point but the streaming deltas and tool progress', async () => {
  const output = cutBefore('success.jsonl', 'agent_end');
  const emitted = withoutStreaming(jsonLines(readFileSync(output, 'utf8')));
  let live: { run: RunRecord; rawEvents: Record<string, unknown>[] } | undefined;

  const { run, rawEvents } = await runWorker({
    output,
    exit: 137,
    lingerMs: 1000,
    whileRunning: async (stateDir) => {
      live = await rawEventsOnceWritten(stateDir, emitted.length);
    },
  });

  assert.ok(live);
  assert.equal(live.run.endTime, null);
  assert.deepEqual(live.rawEvents, emitted);
  assert.equal(run.status, 'error');
  assert.deepEqual(rawEvents, emitted);
});

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' });

test('given a workload whose pi records its requests with the OpenRouter key in its system prompt, when the workload ends, then its request record sits next to its transcript in the state directory, not in its run directory, with the key redacted', async () => {
  const record = (key: string): Record<string, unknown>[] => [
    { type: 'system_prompt', hash: 'h-system', value: [{ type: 'text', text: `The key is ${key}.` }] },
    { type: 'tools', hash: 'h-tools', tools: [{ name: 'bash', description: 'Run a command.' }] },
    {
      type: 'request',
      body: { model: 'z-ai/glm-5', system: { hash: 'h-system' }, messages: [{ role: 'user', hash: 'h-user' }], tools: { hash: 'h-tools' } },
      cacheMarkers: [{ path: ['system', 0], value: { type: 'ephemeral' } }],
    },
  ];

  const { stateDir, run, requestRecord } = await runWorker({
    output: fixture('success.jsonl'),
    requests: outputOf(record(OPENROUTER_KEY)),
  });

  assert.deepEqual(requestRecord, record('[redacted]'));
  assert.ok(existsSync(join(stateDir, 'transcripts', `${run.id}.jsonl`)));
  assert.deepEqual(
    filesUnder(join(stateDir, 'work', run.id)).filter((path) => path.includes('requests')),
    [],
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

test('given workers with and without a reasoning effort and a harness with operator extras, when each runs, then pi receives the json, no-session, lockdown, offline, openrouter contract with the plain model, a thinking level when declared and the model default reasoning extension otherwise, the subagent extension, the extras, and the prompt last', async () => {
  const output = fixture('success.jsonl');

  const withEffort = await runWorker({
    output,
    worker: { reasoningEffort: 'max' },
    harnessArgs: OPERATOR_EXTRAS,
  });
  const withoutEffort = await runWorker({
    output,
    harnessArgs: OPERATOR_EXTRAS,
  });

  assert.deepEqual(withEffort.pi.argv, [
    ...PI_CONTRACT,
    '--thinking',
    'max',
    '-e',
    REQUEST_RECORD_EXTENSION,
    '--append-system-prompt',
    NARRATION_INSTRUCTION,
    '-e',
    EXTENSION,
    ...OPERATOR_EXTRAS,
    'refine the spec',
  ]);
  assert.deepEqual(withoutEffort.pi.argv, [
    ...PI_CONTRACT,
    '-e',
    REASONING_EXTENSION,
    '-e',
    REQUEST_RECORD_EXTENSION,
    '--append-system-prompt',
    NARRATION_INSTRUCTION,
    '-e',
    EXTENSION,
    ...OPERATOR_EXTRAS,
    'refine the spec',
  ]);
});

test('given workers with and without a reasoning effort and a harness with operator extras, when each runs, then the subagent extension is handed the pi binary with the parent contract including its lockdown flags, provider, model and either its thinking level or the model default reasoning extension, never the subagent extension, the extras or the prompt, and a sub-agent system prompt', async () => {
  const output = fixture('success.jsonl');

  const withEffort = await runWorker({
    output,
    worker: { reasoningEffort: 'high' },
    harnessArgs: OPERATOR_EXTRAS,
  });
  const withoutEffort = await runWorker({
    output,
    harnessArgs: OPERATOR_EXTRAS,
  });

  const childOf = (outcome: Outcome) =>
    JSON.parse(outcome.pi.subagentInvocation ?? 'null') as {
      argv: string[];
      systemPrompt: string;
    };
  const withEffortChild = childOf(withEffort);
  const withoutEffortChild = childOf(withoutEffort);
  for (const child of [withEffortChild, withoutEffortChild]) {
    assert.match(child.argv[0] ?? '', /fake-pi\.mjs$/);
  }
  assert.deepEqual(withEffortChild.argv.slice(1), [
    ...PI_CONTRACT,
    '--thinking',
    'high',
    '-e',
    REQUEST_RECORD_EXTENSION,
    '--append-system-prompt',
    NARRATION_INSTRUCTION,
  ]);
  assert.deepEqual(withoutEffortChild.argv.slice(1), [
    ...PI_CONTRACT,
    '-e',
    REASONING_EXTENSION,
    '-e',
    REQUEST_RECORD_EXTENSION,
    '--append-system-prompt',
    NARRATION_INSTRUCTION,
  ]);
  assert.match(NARRATION_INSTRUCTION, /before your first tool call/);
  assert.match(NARRATION_INSTRUCTION, /changes your plan/);
  assert.match(withEffortChild.systemPrompt, /sub-agent/);
  assert.match(withEffortChild.systemPrompt, /returned verbatim/);
  assert.match(withEffortChild.systemPrompt, /cannot spawn sub-agents/);
});

test('given an environment already pointing pi at the writable default, when the worker runs, then pi is spawned with its agent dir set to the run\'s own dir under the state directory', async () => {
  const { pi, run, stateDir } = await runWorker({
    output: fixture('success.jsonl'),
    env: { PI_CODING_AGENT_DIR: '/var/lib/forge/.pi/agent' },
  });

  assert.equal(pi.agentDir, join(stateDir, 'agent', run.id));
});

test('given the models endpoint lists the worker\'s model with a context window, an output limit, reasoning support and prices, when the workload starts, then pi starts with an agent dir whose models.json declares that model with those values, and the sandbox binds the dir read-only', async () => {
  const openRouter = await fakeOpenRouter(billedAt({}), {
    data: [
      {
        id: 'z-ai/glm-5',
        context_length: 202752,
        top_provider: { max_completion_tokens: 131072 },
        supported_parameters: ['tools', 'reasoning'],
        pricing: { prompt: '0.000002', completion: '0.00001', input_cache_read: '0.0000002', input_cache_write: '0.0000025' },
      },
    ],
  });
  try {
    const { pi, bwrap } = await runWorker({ output: fixture('success.jsonl'), openRouterBaseUrl: openRouter.baseUrl });

    assert.ok(pi.agentDir);
    assert.deepEqual(JSON.parse(pi.modelsJson ?? 'null'), {
      providers: {
        openrouter: {
          models: [
            {
              id: 'z-ai/glm-5',
              reasoning: true,
              contextWindow: 202752,
              maxTokens: 131072,
              cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
            },
          ],
        },
      },
    });
    const bind = bwrap.argv.findIndex((arg, at) => arg === '--ro-bind' && bwrap.argv[at + 1] === pi.agentDir);
    assert.notEqual(bind, -1);
    assert.equal(bwrap.argv[bind + 2], pi.agentDir);
    assert.ok(bind < bwrap.argv.indexOf('--remount-ro'));
    assert.equal(statSync(pi.agentDir).mode & 0o222, 0);
    assert.equal(statSync(join(pi.agentDir, 'models.json')).mode & 0o222, 0);
  } finally {
    openRouter.close();
  }
});

test('given the models endpoint lists the worker\'s model without an output limit, without reasoning and at a price too large to scale, when the workload starts, then models.json declares only the context window and that the model does not reason', async () => {
  const openRouter = await fakeOpenRouter(billedAt({}), {
    data: [
      {
        id: 'z-ai/glm-5',
        context_length: 202752,
        supported_parameters: ['tools'],
        pricing: { prompt: '1e308', completion: '1e308' },
      },
    ],
  });
  try {
    const { pi } = await runWorker({ output: fixture('success.jsonl'), openRouterBaseUrl: openRouter.baseUrl });

    assert.deepEqual(JSON.parse(pi.modelsJson ?? 'null'), {
      providers: { openrouter: { models: [{ id: 'z-ai/glm-5', reasoning: false, contextWindow: 202752 }] } },
    });
  } finally {
    openRouter.close();
  }
});

test('given the models endpoint lists the worker\'s model with a context length that is not a number, such as a command string, when the workload starts, then no models.json is written, the journal says so, and the run proceeds', async () => {
  const openRouter = await fakeOpenRouter(billedAt({}), {
    data: [{ id: 'z-ai/glm-5', context_length: '!touch /tmp/planted', pricing: { prompt: '0.000002', completion: '0.00001' } }],
  });
  try {
    const { result, journal } = await journaled(() =>
      runWorker({ output: fixture('success.jsonl'), openRouterBaseUrl: openRouter.baseUrl }),
    );

    assert.equal(result.code, 0);
    assert.equal(result.pi.modelsJson, null);
    assert.match(journal, /lists no context window for z-ai\/glm-5/);
  } finally {
    openRouter.close();
  }
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

test('given a workload about to start, when the runner launches its harness, then pi runs inside bubblewrap with the nix store, the daemon socket and the system files read-only, its own agent dir read-only, its run directory read-write at its real path, fresh /dev, /proc, /tmp and HOME, its own pid, ipc and uts namespaces, no nested user namespaces, and nothing else from the box', async () => {
  const { bwrap, pi, run, stateDir } = await runWorker({
    output: fixture('success.jsonl'),
  });

  const workDir = join(stateDir, 'work', run.id);
  const agentDir = join(stateDir, 'agent', run.id);
  const separator = bwrap.argv.indexOf('--');
  assert.deepEqual(bwrap.argv.slice(0, separator), [
    '--unshare-user',
    '--disable-userns',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--die-with-parent',
    '--new-session',
    '--ro-bind', '/nix/store', '/nix/store',
    '--ro-bind', '/nix/var/nix/daemon-socket', '/nix/var/nix/daemon-socket',
    '--ro-bind', '/etc', '/etc',
    '--ro-bind', '/bin', '/bin',
    '--ro-bind', '/usr', '/usr',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--tmpfs', RUNNER_HOME,
    '--ro-bind', agentDir, agentDir,
    '--bind', workDir, workDir,
    '--remount-ro', '/',
    '--chdir', workDir,
    '--json-status-fd', '3',
  ]);
  assert.deepEqual(bwrap.argv.slice(separator + 1).slice(1), pi.argv);
  assert.equal(pi.cwd, realpathSync(workDir));
});

test('given a harness command reached through a link the sandbox does not carry, like /run/current-system/sw/bin/pi, when the runner launches the harness, then pi and its subagents are started by its real path', async () => {
  const { bwrap, pi } = await runWorker({
    output: fixture('success.jsonl'),
    harness: 'linked',
  });

  const command = bwrap.argv[bwrap.argv.indexOf('--') + 1];
  const [subagentCommand] = (
    JSON.parse(pi.subagentInvocation ?? 'null') as { argv: string[] }
  ).argv;
  assert.match(command ?? '', /fake-pi\.mjs$/);
  assert.equal(command, realpathSync(command ?? ''));
  assert.equal(subagentCommand, command);
});

test('given a harness command that does not exist, or one that is not an absolute path, when the worker runs, then the run is recorded as error naming the command, and pi never starts', async () => {
  const missing = await runWorker({
    output: fixture('success.jsonl'),
    harness: 'missing',
  });
  const relative = await runWorker({
    output: fixture('success.jsonl'),
    harness: 'relative',
  });

  assert.ok(
    (missing.run.error ?? '').startsWith(
      `the harness command ${systemPi(missing.stateDir)} cannot be resolved: ENOENT`,
    ),
    missing.run.error ?? '',
  );
  assert.equal(
    relative.run.error,
    'the harness command pi cannot be resolved: it is not an absolute path',
  );
  for (const { code, run, piStarted } of [missing, relative]) {
    assert.equal(code, 1);
    assert.equal(run.status, 'error');
    assert.equal(piStarted, false);
  }
});

test('given a runner whose own environment holds more than the harness needs, when it launches the harness, then the harness environment holds only the system settings, its throwaway HOME, the OpenRouter key and pi\'s own variables', async () => {
  const { bwrap } = await runWorker({
    output: fixture('success.jsonl'),
    env: {
      PATH: '/nix/store/00000000000000000000000000000000-toolset/bin',
      LANG: 'en_US.UTF-8',
      LOCALE_ARCHIVE: '/nix/store/00000000000000000000000000000000-locales/lib/locale/locale-archive',
      TZDIR: '/etc/zoneinfo',
      GITHUB_TOKEN: 'github_pat_from_the_runner',
      FORGE_GITHUB_WRITE_TOKEN_FILE: '/run/credentials/forge-dispatch@forge:113.service/github-write-token',
      CREDENTIALS_DIRECTORY: '/run/credentials/forge-runner@refiner.service',
      NODE_OPTIONS: '--require /var/lib/forge/planted.js',
      GIT_CONFIG_COUNT: '0',
    },
  });

  assert.deepEqual(Object.keys(bwrap.env).sort(), [
    'FORGE_PI_REQUEST_RECORD_FD',
    'FORGE_PI_SUBAGENT_INVOCATION',
    'HOME',
    'LANG',
    'LOCALE_ARCHIVE',
    'OPENROUTER_API_KEY',
    'PATH',
    'PI_CODING_AGENT_DIR',
    'TZDIR',
  ]);
  assert.equal(bwrap.env.OPENROUTER_API_KEY, OPENROUTER_KEY);
  assert.equal(bwrap.env.HOME, RUNNER_HOME);
});

test('given a sandbox that cannot set up or a bubblewrap that is missing, when the runner launches the harness, then the run is error naming the sandbox and why, and pi never starts', async () => {
  const refused = await journaled(() =>
    runWorker({
      output: fixture('success.jsonl'),
      bwrapFailure: 'bwrap: setting up uid map: Permission denied',
    }),
  ).then(({ result }) => result);
  const missing = await runWorker({
    output: fixture('success.jsonl'),
    env: { FORGE_BWRAP: '/nix/store/00000000000000000000000000000000-bubblewrap/bin/bwrap' },
  });

  assert.equal(
    refused.run.error,
    'the workload sandbox could not start: bwrap: setting up uid map: Permission denied',
  );
  assert.equal(
    missing.run.error,
    'the workload sandbox could not start: spawn /nix/store/00000000000000000000000000000000-bubblewrap/bin/bwrap ENOENT',
  );
  for (const { code, run, piStarted } of [refused, missing]) {
    assert.equal(code, 1);
    assert.equal(run.status, 'error');
    assert.equal(piStarted, false);
  }
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

test('given a worker with a one-second timeout and a pi that keeps running, when the worker runs, then pi is killed and the run ends exceeded on its timeout with the timeout recorded and the runner exits as for a failure', async () => {
  const { code, run, pi } = await runWorker({
    output: cutBefore('success.jsonl', 'agent_end'),
    lingerMs: 10_000,
    worker: { timeoutSeconds: 1 },
  });

  assert.equal(code, 1);
  assert.equal(run.status, 'exceeded');
  assert.equal(run.exceededLimit, 'timeout');
  assert.equal(run.timeoutSeconds, 1);
  assert.notEqual(run.endTime, null);
  assert.equal(isAlive(pi.pid), false);
});

test('given a worker with a budget the first generation\'s estimated cost passes and a pi that keeps running, when the worker runs, then pi is killed and the run ends exceeded on its budget with the budget recorded and the runner exits as for a failure', async () => {
  const openRouter = await fakeOpenRouter(billedAt({}), LISTED_MODELS);
  try {
    const { code, run, pi } = await runWorker({
      output: cutBefore('success.jsonl', 'agent_end'),
      openRouterBaseUrl: openRouter.baseUrl,
      lingerMs: 10_000,
      worker: { maxCostUsd: 0.002 },
    });

    assert.equal(code, 1);
    assert.equal(run.status, 'exceeded');
    assert.equal(run.exceededLimit, 'budget');
    assert.equal(run.maxCostUsd, 0.002);
    assert.notEqual(run.endTime, null);
    assert.equal(isAlive(pi.pid), false);
  } finally {
    openRouter.close();
  }
});

test('given a worker whose budget its main agent alone stays under but its subagents take it over, when the crossing subagent generation is recorded, then pi is killed, nothing after that generation is recorded, and the run ends exceeded on its budget', async () => {
  const openRouter = await fakeOpenRouter(billedAt({}), LISTED_MODELS);
  try {
    const { run, pi, stateDir } = await runWorker({
      output: fixture('subagents.jsonl'),
      openRouterBaseUrl: openRouter.baseUrl,
      lingerMs: 10_000,
      worker: { maxCostUsd: 0.0023 },
    });

    assert.equal(run.status, 'exceeded');
    assert.equal(run.exceededLimit, 'budget');
    assert.equal(isAlive(pi.pid), false);
    assert.deepEqual(
      storedGenerations(stateDir, run.id).map(({ generationId }) => generationId),
      ['gen-subagents-1', 'gen-child-beta-1'],
    );
  } finally {
    openRouter.close();
  }
});

test('given a worker with a budget whose model the models endpoint does not list, when the worker runs, then pi never starts and the run ends error saying the model could not be priced, having spent nothing', async () => {
  const openRouter = await fakeOpenRouter(billedAt({}), {
    data: [{ id: 'z-ai/glm-4.6', pricing: { prompt: '0.0000006', completion: '0.0000022' } }],
  });
  try {
    const { code, run, piStarted, stateDir } = await runWorker({
      output: fixture('success.jsonl'),
      openRouterBaseUrl: openRouter.baseUrl,
      worker: { maxCostUsd: 5 },
    });

    assert.equal(code, 1);
    assert.equal(piStarted, false);
    assert.equal(run.status, 'error');
    assert.equal(run.maxCostUsd, 5);
    assert.match(run.error ?? '', /z-ai\/glm-5.*could not be priced.*not listed/);
    assert.equal(run.costUsd, 0);
    assert.deepEqual(storedGenerations(stateDir, run.id), []);
  } finally {
    openRouter.close();
  }
});

test('given a worker whose budget is null and a model priced at 1 USD a token, when its generations cost far more than any default, then it runs to its own end and records no budget', async () => {
  const openRouter = await fakeOpenRouter(billedAt({}), {
    data: [{ id: 'z-ai/glm-5', pricing: { prompt: '1', completion: '1', input_cache_read: '1', input_cache_write: '1' } }],
  });
  try {
    const { code, run } = await runWorker({
      output: fixture('success.jsonl'),
      openRouterBaseUrl: openRouter.baseUrl,
      worker: { maxCostUsd: null },
    });

    assert.equal(code, 0);
    assert.equal(run.status, 'success');
    assert.equal(run.maxCostUsd, null);
    assert.ok(run.costUsd > 100);
  } finally {
    openRouter.close();
  }
});

test('given a worker with no budget whose model the models endpoint does not list, when the worker runs, then pi starts as before', async () => {
  const { code, piStarted } = await runWorker({
    output: fixture('success.jsonl'),
    worker: { maxCostUsd: null },
  });

  assert.equal(code, 0);
  assert.equal(piStarted, true);
});

test('given a worker with a generous budget and a listed model with no cache prices, when a generation that wrote to the cache is recorded with neither a billed nor an estimated cost, then the workload ends exceeded on its budget at that generation', async () => {
  const openRouter = await fakeOpenRouter(billedAt({}), {
    data: [{ id: 'z-ai/glm-5', pricing: { prompt: '0.000002', completion: '0.00001' } }],
  });
  try {
    const { run, stateDir, pi } = await runWorker({
      output: fixture('success.jsonl'),
      openRouterBaseUrl: openRouter.baseUrl,
      lingerMs: 10_000,
      worker: { maxCostUsd: 100 },
    });

    assert.equal(run.status, 'exceeded');
    assert.equal(run.exceededLimit, 'budget');
    assert.equal(isAlive(pi.pid), false);
    assert.deepEqual(
      storedGenerations(stateDir, run.id).map(({ generationId }) => generationId),
      ['gen-success-1'],
    );
  } finally {
    openRouter.close();
  }
});

test('given a worker, recorded pi output of a successful run, and an OpenRouter that answers not found for every generation, when the worker runs, then the run is success with its tokens and a pending cost, the runner never calls OpenRouter, and the dashboard shows the cost as pending', async () => {
  const openRouter = await fakeOpenRouter(billedAt({}));
  try {
    const { code, stateDir, run } = await runWorker({
      output: fixture('success.jsonl'),
      openRouterBaseUrl: openRouter.baseUrl,
    });

    assert.equal(code, 0);
    assert.equal(run.status, 'success');
    assert.equal(run.inputTokens, 200 + 100);
    assert.equal(run.outputTokens, 40 + 25);
    assert.equal(run.costStatus, 'pending');
    assert.equal(run.costUsd, 0);
    assert.deepEqual(openRouter.lookups, []);
    assert.equal(await dashboardCost(stateDir), 'pending');
  } finally {
    openRouter.close();
  }
});

test('given a finished run whose generations OpenRouter answers with not found for the first two lookups and then with a billed total, when the billing service fires three times, then the run is pending after the first two and billed after the third at the sum of the billed totals, looked up with the billing key', async () => {
  const openRouter = await fakeOpenRouter((id, attempt) =>
    attempt <= 2 ? { status: 404, body: { error: { code: 404 } } } : billed(id, attempt),
  );
  try {
    const { stateDir, run } = await runWorker({
      output: fixture('success.jsonl'),
    });

    const statuses: string[] = [];
    for (let firing = 0; firing < 3; firing += 1) {
      assert.equal(await fire(stateDir, openRouter), 0);
      statuses.push(storedRun(stateDir, run.id).costStatus);
    }

    assert.deepEqual(statuses, ['pending', 'pending', 'billed']);
    assert.equal(storedRun(stateDir, run.id).costUsd, 0.0125 + 0.0375);
    assert.equal(await dashboardCost(stateDir), '$0.050000');
    assert.equal(openRouter.lookups.length, 6);
    for (const lookup of openRouter.lookups) {
      assert.equal(lookup.authorization, `Bearer ${OPENROUTER_KEY}`);
    }
  } finally {
    openRouter.close();
  }
});

test('given a finished run whose generations carry pi\'s token counts, and OpenRouter returns native counts, a reasoning token count, a provider and a billed cost for the first while the second is not yet available, when the billing service fires and then fires again once both are, then each billed generation takes OpenRouter\'s figures, the unbilled one keeps pi\'s with no provider, and the run totals follow', async () => {
  const native = {
    'gen-success-1': {
      native_tokens_prompt: 1250,
      native_tokens_cached: 0,
      native_tokens_completion: 45,
      native_tokens_reasoning: 12,
      provider_name: 'Z.AI',
      total_cost: 0.0125,
    },
    'gen-success-2': {
      native_tokens_prompt: 1400,
      native_tokens_cached: 1100,
      native_tokens_completion: 30,
      native_tokens_reasoning: 0,
      provider_name: 'Novita',
      total_cost: 0.0375,
    },
  };
  let available = ['gen-success-1'];
  const openRouter = await fakeOpenRouter((id) =>
    available.includes(id)
      ? { status: 200, body: { data: { id, ...native[id as keyof typeof native] } } }
      : { status: 404, body: { error: { code: 404 } } },
  );
  const figures = (stateDir: string, runId: string) => {
    const run = storedRun(stateDir, runId);
    return {
      generations: storedGenerations(stateDir, runId).map(
        ({ generationId, usage, reasoningTokens, provider, billedCostUsd }) => ({
          generationId,
          usage,
          reasoningTokens,
          provider,
          billedCostUsd,
        }),
      ),
      totals: {
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        cacheReadTokens: run.cacheReadTokens,
        cacheWriteTokens: run.cacheWriteTokens,
      },
    };
  };
  const billedFirst = {
    generationId: 'gen-success-1',
    usage: { inputTokens: 250, outputTokens: 45, cacheReadTokens: 0, cacheWriteTokens: 1000 },
    reasoningTokens: 12,
    provider: 'Z.AI',
    billedCostUsd: 0.0125,
  };
  try {
    const { stateDir, run } = await runWorker({ output: fixture('success.jsonl') });

    await fire(stateDir, openRouter);

    assert.deepEqual(figures(stateDir, run.id), {
      generations: [
        billedFirst,
        {
          generationId: 'gen-success-2',
          usage: { inputTokens: 100, outputTokens: 25, cacheReadTokens: 1000, cacheWriteTokens: 200 },
          reasoningTokens: null,
          provider: null,
          billedCostUsd: null,
        },
      ],
      totals: { inputTokens: 350, outputTokens: 70, cacheReadTokens: 1000, cacheWriteTokens: 1200 },
    });

    available = ['gen-success-1', 'gen-success-2'];
    await fire(stateDir, openRouter);

    assert.deepEqual(figures(stateDir, run.id), {
      generations: [
        billedFirst,
        {
          generationId: 'gen-success-2',
          usage: { inputTokens: 100, outputTokens: 30, cacheReadTokens: 1100, cacheWriteTokens: 200 },
          reasoningTokens: 0,
          provider: 'Novita',
          billedCostUsd: 0.0375,
        },
      ],
      totals: { inputTokens: 350, outputTokens: 75, cacheReadTokens: 1100, cacheWriteTokens: 1200 },
    });
    assert.equal(storedRun(stateDir, run.id).costStatus, 'billed');
  } finally {
    openRouter.close();
  }
});

test('given a finished run whose first generation OpenRouter bills as served by a model other than the worker\'s, and a second it has not billed, when the billing service fires, then the first records the serving model and the second records none', async () => {
  const openRouter = await fakeOpenRouter((id) =>
    id === 'gen-success-1'
      ? { status: 200, body: { data: { id, total_cost: 0.0125, model: 'z-ai/glm-5.1' } } }
      : { status: 404, body: { error: { code: 404 } } },
  );
  try {
    const { stateDir, run } = await runWorker({ output: fixture('success.jsonl') });

    await fire(stateDir, openRouter);

    assert.deepEqual(
      storedGenerations(stateDir, run.id).map(({ generationId, servedModel }) => ({ generationId, servedModel })),
      [
        { generationId: 'gen-success-1', servedModel: 'z-ai/glm-5.1' },
        { generationId: 'gen-success-2', servedModel: null },
      ],
    );
  } finally {
    openRouter.close();
  }
});

test('given a finished run whose generation OpenRouter bills with native counts that are missing, null, negative, fractional or not numbers, and a provider that is empty or not a string, when the billing service fires, then the generation is billed at its cost and keeps pi\'s counts with no reasoning tokens or provider', async () => {
  const valid = {
    native_tokens_prompt: 1400,
    native_tokens_cached: 1100,
    native_tokens_completion: 30,
  };
  const malformed = [
    {},
    { ...valid, native_tokens_cached: null, native_tokens_reasoning: null, provider_name: null },
    { ...valid, native_tokens_prompt: -1, native_tokens_reasoning: -1, provider_name: '' },
    { ...valid, native_tokens_completion: 1.5, native_tokens_reasoning: 2.5, provider_name: 7 },
    { ...valid, native_tokens_prompt: '1400', native_tokens_reasoning: '3', provider_name: ['Novita'] },
  ];
  for (const fields of malformed) {
    const openRouter = await fakeOpenRouter((id) => ({
      status: 200,
      body: { data: { id, total_cost: 0.0375, ...(id === 'gen-success-2' ? fields : {}) } },
    }));
    try {
      const { stateDir, run } = await runWorker({ output: fixture('success.jsonl') });

      await fire(stateDir, openRouter);

      const generation = storedGenerations(stateDir, run.id).find(
        ({ generationId }) => generationId === 'gen-success-2',
      );
      assert.deepEqual(
        {
          usage: generation?.usage,
          reasoningTokens: generation?.reasoningTokens,
          provider: generation?.provider,
          billedCostUsd: generation?.billedCostUsd,
        },
        {
          usage: { inputTokens: 100, outputTokens: 25, cacheReadTokens: 1000, cacheWriteTokens: 200 },
          reasoningTokens: null,
          provider: null,
          billedCostUsd: 0.0375,
        },
        JSON.stringify(fields),
      );
    } finally {
      openRouter.close();
    }
  }
});

test('given recorded pi output of three generations followed by pi dying without a result, when the worker runs and the billing service then fires, then the run is error, its token totals are the sum of those three generations, and each is billed and counted in its cost', async () => {
  const openRouter = await fakeOpenRouter(billed);
  try {
    const { code, stateDir, run } = await runWorker({
      output: cutBefore('tool-calls.jsonl', 'agent_end'),
      exit: 137,
    });
    assert.equal(code, 1);
    assert.equal(run.status, 'error');
    assert.equal(run.costStatus, 'pending');
    assert.deepEqual(
      {
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        cacheReadTokens: run.cacheReadTokens,
        cacheWriteTokens: run.cacheWriteTokens,
      },
      {
        inputTokens: 1000 + 100 + 100,
        outputTokens: 15 + 12 + 8,
        cacheReadTokens: 0 + 1000 + 1100,
        cacheWriteTokens: 0,
      },
    );

    await fire(stateDir, openRouter);

    const settledRun = storedRun(stateDir, run.id);
    assert.equal(settledRun.status, 'error');
    assert.equal(settledRun.costUsd, 0.01 + 0.02 + 0.04);
    assert.equal(settledRun.costStatus, 'billed');
    assert.deepEqual(
      openRouter.lookups.map((lookup) => lookup.id).sort(),
      ['gen-tools-1', 'gen-tools-2', 'gen-tools-3'],
    );
  } finally {
    openRouter.close();
  }
});

test('given recorded pi output where an assistant response used tokens but carries no generation id, when the worker runs, then its cost is unconfirmed without any billing firing, and the generation that has an id is still settled', async () => {
  const openRouter = await fakeOpenRouter(billed);
  try {
    const { result: outcome, journal } = await journaled(() =>
      runWorker({ output: withoutGenerationId('success.jsonl', 'gen-success-2') }),
    );
    assert.equal(outcome.run.status, 'success');
    assert.equal(outcome.run.costStatus, 'unconfirmed');
    assert.match(journal, /no generation id/);

    await fire(outcome.stateDir, openRouter);

    const settledRun = storedRun(outcome.stateDir, outcome.run.id);
    assert.equal(settledRun.costStatus, 'unconfirmed');
    assert.equal(settledRun.costUsd, 0.0125);
    assert.deepEqual(
      openRouter.lookups.map((lookup) => lookup.id),
      ['gen-success-1'],
    );
  } finally {
    openRouter.close();
  }
});

test('given finished runs whose generation OpenRouter answers with a rejected key, a forbidden request, a bad request, a body with no numeric total_cost, or a body that is not json, when the billing service fires, then each run is unconfirmed with the cost it could look up, those generations are never looked up again, and the journal names each generation and why without the key', async () => {
  const failures: [ReturnType<GenerationStats>, RegExp][] = [
    [{ status: 401, body: { error: { code: 401 } } }, /HTTP 401/],
    [{ status: 403, body: { error: { code: 403 } } }, /HTTP 403/],
    [{ status: 400, body: { error: { code: 400 } } }, /HTTP 400/],
    [{ status: 200, body: { data: { id: 'gen-success-2' } } }, /total_cost/],
    [{ status: 200, body: 'not json' }, /SyntaxError/],
  ];

  const { result: outcomes, journal } = await journaled(() =>
    Promise.all(
      failures.map(async ([failure]) => {
        const openRouter = await fakeOpenRouter((id, attempt) =>
          id === 'gen-success-2' ? failure : billed(id, attempt),
        );
        try {
          const { stateDir, run } = await runWorker({
            output: fixture('success.jsonl'),
          });
          await fire(stateDir, openRouter);
          await fire(stateDir, openRouter);
          return {
            run: storedRun(stateDir, run.id),
            lookups: openRouter.lookups.map((lookup) => lookup.id).sort(),
          };
        } finally {
          openRouter.close();
        }
      }),
    ),
  );

  for (const { run, lookups } of outcomes) {
    assert.equal(run.status, 'success');
    assert.equal(run.costUsd, 0.0125);
    assert.equal(run.costStatus, 'unconfirmed');
    assert.deepEqual(lookups, ['gen-success-1', 'gen-success-2']);
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

test('given a finished run whose generation OpenRouter answers first with a rate limit, then a server error, then a dropped connection, then a billed total, when the billing service fires four times, then the run stays pending until the fourth firing and is then billed', async () => {
  const temporaries: ReturnType<GenerationStats>[] = [
    { status: 429, body: { error: { code: 429 } } },
    { status: 503, body: { error: { code: 503 } } },
    'reset',
  ];
  const openRouter = await fakeOpenRouter((id, attempt) =>
    id === 'gen-success-2' && attempt <= temporaries.length
      ? (temporaries[attempt - 1] as ReturnType<GenerationStats>)
      : billed(id, attempt),
  );
  try {
    const { stateDir, run } = await runWorker({
      output: fixture('success.jsonl'),
    });

    const statuses: string[] = [];
    for (let firing = 0; firing < 4; firing += 1) {
      await fire(stateDir, openRouter);
      statuses.push(storedRun(stateDir, run.id).costStatus);
    }

    assert.deepEqual(statuses, ['pending', 'pending', 'pending', 'billed']);
    assert.equal(storedRun(stateDir, run.id).costUsd, 0.0125 + 0.0375);
    assert.equal(
      openRouter.lookups.filter((lookup) => lookup.id === 'gen-success-2').length,
      4,
    );
  } finally {
    openRouter.close();
  }
});

test('given a finished run whose generation lookup gets no answer at first and then a billed total, when the billing service fires twice, then the unanswered lookup is retried and the run is billed', async () => {
  const openRouter = await fakeOpenRouter((id, attempt) =>
    id === 'gen-success-2' && attempt === 1 ? 'hang' : billed(id, attempt),
  );
  try {
    const { stateDir, run } = await runWorker({
      output: fixture('success.jsonl'),
    });

    await fire(stateDir, openRouter);
    assert.equal(storedRun(stateDir, run.id).costStatus, 'pending');
    await fire(stateDir, openRouter);

    assert.equal(storedRun(stateDir, run.id).costStatus, 'billed');
    assert.equal(storedRun(stateDir, run.id).costUsd, 0.0125 + 0.0375);
  } finally {
    openRouter.close();
  }
});

test('given a recorded run where the parent makes two parallel subagent calls, when the billing service fires, then the run cost is the sum of the parent and both children, each generation looked up once, and each child generation records the subagent it came from', async () => {
  const { stateDir, run, lookups } = await settled({
    output: fixture('subagents.jsonl'),
  });

  assert.equal(run.status, 'success');
  assert.equal(run.inputTokens, 400 + 300 + (600 + 100) + 500);
  assert.equal(run.cacheReadTokens, 1000 + 1200 + (0 + 600) + 0);
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
  assert.deepEqual(
    storedGenerations(stateDir, run.id)
      .map(({ generationId, subagent, billedCostUsd }) => ({
        generationId,
        subagent,
        billedCostUsd,
      }))
      .sort((a, b) => String(a.generationId).localeCompare(String(b.generationId))),
    [
      { generationId: 'gen-child-alpha-1', subagent: 'call_alpha', billedCostUsd: 0.125 },
      { generationId: 'gen-child-alpha-2', subagent: 'call_alpha', billedCostUsd: 0.0625 },
      { generationId: 'gen-child-beta-1', subagent: 'call_beta', billedCostUsd: 0.03125 },
      { generationId: 'gen-subagents-1', subagent: null, billedCostUsd: 0.5 },
      { generationId: 'gen-subagents-2', subagent: null, billedCostUsd: 0.25 },
    ],
  );
});

test('given a recording where one subagent call returns an error and the parent finishes normally, when the billing service fires, then the run succeeds and its tokens and billed cost still count the failed child', async () => {
  const { run } = await settled({ output: fixture('subagent-failure.jsonl') });

  assert.equal(run.status, 'success');
  assert.equal(run.error, null);
  assert.equal(run.inputTokens, 400 + 300 + 600 + 500);
  assert.equal(run.cacheReadTokens, 1000 + 1200 + 0 + 0);
  assert.equal(run.outputTokens, 30 + 10 + 20 + 6);
  assert.equal(run.costUsd, 0.5 + 0.25 + 0.125 + 0.03125);
  assert.equal(run.costStatus, 'billed');
});

test('given recorded pi output where a failed attempt is retried and then succeeds, when the billing service fires, then the run is success and its tokens and billed cost include the failed attempt', async () => {
  const { code, run } = await settled({ output: fixture('retry.jsonl') });

  assert.equal(code, 0);
  assert.equal(run.status, 'success');
  assert.equal(run.inputTokens, 900 + 400);
  assert.equal(run.cacheReadTokens, 300);
  assert.equal(run.outputTokens, 3 + 8);
  assert.equal(run.costUsd, 0.002 + 0.004);
  assert.equal(run.costStatus, 'billed');
});

test('given recorded pi output ending in a provider error with no generation and pi exiting 0, when the worker runs, then the run is error with pi error message, the runner exits non-zero, and its zero cost is billed without any billing firing', async () => {
  const { code, run } = await runWorker({
    output: fixture('provider-error.jsonl'),
  });

  assert.equal(code, 1);
  assert.equal(run.status, 'error');
  assert.equal(
    run.error,
    '400: {"code":400,"message":"z-ai/glm-5 is not a valid model ID"}',
  );
  assert.equal(run.costUsd, 0);
  assert.equal(run.costStatus, 'billed');
});

test('given a long run with many generations, one of them reported twice, when the billing service fires, then each generation is billed once and at most four lookups are in flight at a time', async () => {
  const ids = Array.from({ length: 12 }, (_, index) => `gen-long-${index}`);
  const costs = Object.fromEntries(ids.map((id) => [id, 0.5]));

  const { run, lookups } = await settled(
    { output: withGenerations('success.jsonl', [...ids, 'gen-long-0']) },
    (id, attempt) => {
      const reply = billedAt({ ...BILLED_BY_ID, ...costs })(id, attempt);
      return typeof reply === 'string' ? reply : { ...reply, delayMs: 20 };
    },
  );

  assert.equal(run.status, 'success');
  assert.equal(run.costStatus, 'billed');
  assert.equal(run.costUsd, 0.0125 + 0.0375 + 12 * 0.5);
  assert.equal(lookups.length, 14);
  assert.ok(Math.max(...lookups.map((lookup) => lookup.inFlight)) <= 4);
});

test('given a billing service with no OpenRouter key, a key that is not a valid header value, or a base URL that is not a valid URL, when it fires, then it fails naming the problem without the key, looks nothing up, and leaves the run pending for a fixed configuration to settle', async () => {
  const openRouter = await fakeOpenRouter(billed);
  try {
    const { stateDir, run } = await runWorker({
      output: fixture('success.jsonl'),
    });

    for (const [env, problem] of [
      [{ OPENROUTER_API_KEY: undefined }, /OPENROUTER_API_KEY is not set/],
      [{ OPENROUTER_API_KEY: 'sk-or-secret\nleak' }, /OPENROUTER_API_KEY is malformed/],
      [{ OPENROUTER_BASE_URL: 'openrouter.ai/api/v1' }, /OPENROUTER_BASE_URL/],
    ] as const) {
      await assert.rejects(fire(stateDir, openRouter, env), (error: Error) => {
        assert.match(error.message, problem);
        assert.doesNotMatch(error.message, /sk-or-secret/);
        return true;
      });
    }

    assert.deepEqual(openRouter.lookups, []);
    assert.equal(storedRun(stateDir, run.id).costStatus, 'pending');
    assert.ok(
      storedGenerations(stateDir, run.id).every(
        (generation) => generation.attempts === 0,
      ),
    );
    await fire(stateDir, openRouter);
    assert.equal(storedRun(stateDir, run.id).costStatus, 'billed');
  } finally {
    openRouter.close();
  }
});

test('given a runner whose subagent extension, model default reasoning extension, request record extension, bubblewrap or HOME is missing, empty, or relative, when a pi worker runs, then the runner refuses naming the variable before starting pi', async () => {
  const valid = {
    FORGE_PI_SUBAGENT_EXTENSION: EXTENSION,
    FORGE_PI_MODEL_DEFAULT_REASONING_EXTENSION: REASONING_EXTENSION,
    FORGE_PI_REQUEST_RECORD_EXTENSION: REQUEST_RECORD_EXTENSION,
    FORGE_BWRAP: '/nix/store/00000000000000000000000000000000-bubblewrap/bin/bwrap',
    HOME: RUNNER_HOME,
  };
  const cases = [undefined, '', 'pi'].flatMap((value) =>
    Object.keys(valid).map((name): [NodeJS.ProcessEnv, RegExp] => [
      { ...valid, [name]: value },
      new RegExp(`${name} is not set to an absolute path`),
    ]),
  );

  for (const [env, refusal] of cases) {
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
        ...env,
      }),
      refusal,
    );
    assert.deepEqual(readdirSync(stateDir), ['runtime.json']);
  }
});

test('given a worker whose prompt contains the OpenRouter key, when it runs against the recorded pi, then the first transcript event is the prompt as a user message with the key redacted', async () => {
  const { transcript } = await runWorker({
    output: fixture('success.jsonl'),
    worker: { prompt: `refine the spec with ${OPENROUTER_KEY}` },
  });

  const [first] = parseTranscript(transcript);
  assert.equal(first?.type, 'message');
  assert.equal(first?.type === 'message' && first.role, 'user');
  assert.equal(
    first?.type === 'message' && first.text,
    'refine the spec with [redacted]',
  );
});

const requestsOf = (system: string, tools = 'h-tools'): string =>
  outputOf([
    { type: 'system_prompt', hash: system, value: [{ type: 'text', text: system }] },
    { type: 'tools', hash: tools, tools: [{ name: 'bash' }] },
    {
      type: 'request',
      body: { model: 'z-ai/glm-5', system: { hash: system }, messages: [{ role: 'user', hash: 'h-user' }], tools: { hash: tools } },
      cacheMarkers: [],
    },
  ]);

test('given a worker with a model, an effort, extra args and a prompt, when the workload runs, then it records a fingerprint holding those fields, the prompt, system prompt and tool hashes and the harness version, a hash over it, and forge\'s git sha', async () => {
  const { stateDir, run } = await runWorker({
    output: fixture('success.jsonl'),
    requests: requestsOf('h-system'),
    worker: { model: 'z-ai/glm-5', reasoningEffort: 'high', prompt: 'refine the spec' },
    harnessArgs: OPERATOR_EXTRAS,
    piVersion: '1.4.2',
    env: { FORGE_GIT_SHA: 'abc1234' },
  });

  const recorded = withStore(stateDir, (store) => store.getFingerprint(run.id));

  assert.deepEqual(recorded?.fingerprint, {
    model: 'z-ai/glm-5',
    reasoningEffort: 'high',
    harnessArgs: OPERATOR_EXTRAS,
    harnessVersion: '1.4.2',
    promptTemplate: sha256('refine the spec'),
    systemPrompt: canonicalHash([sha256(JSON.stringify([{ type: 'text', text: 'h-system' }]))]),
    tools: 'h-tools',
    skills: null,
  });
  assert.ok(recorded);
  assert.equal(recorded.hash, fingerprintHash(recorded.fingerprint));
  assert.equal(recorded?.forgeGitSha, 'abc1234');
  assert.equal(recorded?.baseCommit, null);
});

test('given two workers identical except that one sets provider openrouter and the other leaves it unset, when each runs a workload, then pi gets the same argv, env keys and models.json, and the fingerprint hash is equal', async () => {
  const run = async (worker: Partial<WorkerConfig>) => {
    const outcome = await runWorker({
      output: fixture('success.jsonl'),
      requests: requestsOf('h-system'),
      worker,
      harnessArgs: OPERATOR_EXTRAS,
      piVersion: '1.4.2',
    });
    return {
      argv: outcome.pi.argv,
      modelsJson: outcome.pi.modelsJson,
      env: Object.keys(outcome.bwrap.env).sort(),
      key: outcome.bwrap.env.OPENROUTER_API_KEY,
      fingerprint: withStore(outcome.stateDir, (store) =>
        store.getFingerprint(outcome.run.id),
      ),
    };
  };

  const explicit = await run({ provider: 'openrouter' });
  const unset = await run({});

  assert.deepEqual(explicit.argv, unset.argv);
  assert.ok(explicit.argv.includes('openrouter'));
  assert.equal(explicit.modelsJson, unset.modelsJson);
  assert.deepEqual(explicit.env, unset.env);
  assert.equal(explicit.key, OPENROUTER_KEY);
  assert.equal(unset.key, OPENROUTER_KEY);
  assert.ok(explicit.fingerprint);
  assert.equal(explicit.fingerprint.hash, unset.fingerprint?.hash);
  assert.deepEqual(
    Object.keys(explicit.fingerprint.fingerprint).sort(),
    [
      'harnessArgs',
      'harnessVersion',
      'model',
      'promptTemplate',
      'reasoningEffort',
      'skills',
      'systemPrompt',
      'tools',
    ],
  );
});

test('given two workloads of one worker with an unchanged config, when both run from different forge git shas, then their fingerprint hashes are equal and each keeps its sha', async () => {
  const run = async (sha: string) => {
    const { stateDir, run } = await runWorker({
      output: fixture('success.jsonl'),
      requests: requestsOf('h-system'),
      env: { FORGE_GIT_SHA: sha },
    });
    return withStore(stateDir, (store) => store.getFingerprint(run.id));
  };

  const first = await run('aaa1111');
  const second = await run('bbb2222');

  assert.ok(first);
  assert.equal(first.hash, second?.hash);
  assert.deepEqual([first.forgeGitSha, second?.forgeGitSha], ['aaa1111', 'bbb2222']);
});

test('given two workloads whose system prompts differ, when both run, then their fingerprint hashes differ', async () => {
  const run = async (system: string) => {
    const { stateDir, run } = await runWorker({
      output: fixture('success.jsonl'),
      requests: requestsOf(system),
    });
    return withStore(stateDir, (store) => store.getFingerprint(run.id));
  };

  assert.notEqual((await run('h-one'))?.hash, (await run('h-two'))?.hash);
});

test('given a workload whose pi never made a request, when it ends, then its fingerprint is recorded with no system prompt or tool hash', async () => {
  const { stateDir, run } = await runWorker({ output: fixture('success.jsonl') });

  const recorded = withStore(stateDir, (store) => store.getFingerprint(run.id));

  assert.equal(recorded?.fingerprint.systemPrompt, null);
  assert.equal(recorded?.fingerprint.tools, null);
  assert.equal(recorded?.forgeGitSha, null);
});

const cwdRequests = (): string =>
  outputOf([
    { type: 'system_prompt', hash: 'h-$CWD', value: [{ type: 'text', text: 'You are pi.\nCurrent working directory: $CWD' }] },
    { type: 'tools', hash: 'h-tools', tools: [{ name: 'bash' }] },
    {
      type: 'request',
      body: { model: 'z-ai/glm-5', system: { hash: 'h-$CWD' }, messages: [{ role: 'user', hash: 'h-user' }], tools: { hash: 'h-tools' } },
      cacheMarkers: [],
    },
  ]);

test('given two workloads of one worker whose system prompt names the working directory each was run in, when both run, then their fingerprint hashes are equal', async () => {
  const run = async () => {
    const { stateDir, run } = await runWorker({
      output: fixture('success.jsonl'),
      requests: cwdRequests(),
    });
    return withStore(stateDir, (store) => store.getFingerprint(run.id));
  };

  const first = await run();
  const second = await run();

  assert.ok(first && second);
  assert.equal(first.hash, second.hash);
});

test('given a harness whose version cannot be read, when the workload runs, then its fingerprint records no version but keeps the configured extra args', async () => {
  const { stateDir, run } = await runWorker({
    output: fixture('success.jsonl'),
    harnessArgs: OPERATOR_EXTRAS,
    piVersion: null,
  });

  const recorded = withStore(stateDir, (store) => store.getFingerprint(run.id));

  assert.equal(run.status, 'success');
  assert.equal(recorded?.fingerprint.harnessVersion, null);
  assert.deepEqual(recorded?.fingerprint.harnessArgs, OPERATOR_EXTRAS);
});

test('given an empty FORGE_GIT_SHA, when the workload runs, then no git sha is recorded', async () => {
  const { stateDir, run } = await runWorker({
    output: fixture('success.jsonl'),
    env: { FORGE_GIT_SHA: '' },
  });

  assert.equal(withStore(stateDir, (store) => store.getFingerprint(run.id))?.forgeGitSha, null);
});

const SUBSCRIPTION_WORKER: Partial<WorkerConfig> = {
  provider: 'anthropic',
  model: 'claude-opus-5-5',
};

const subscriptionScenario = (
  name: string,
  overrides: Partial<Scenario> = {},
): Scenario => ({
  output: fixture(name),
  anthropicToken: ANTHROPIC_TOKEN,
  worker: SUBSCRIPTION_WORKER,
  ...overrides,
});

test('given a worker on the anthropic provider and a token in the runner environment, when its workload runs, then pi runs with the anthropic provider and the worker\'s model, the sandbox holds the token and not the OpenRouter key, no models file is written, and OpenRouter is never asked', async () => {
  const outcome = await runWorker(subscriptionScenario('anthropic-success.jsonl'));

  assert.equal(outcome.code, 0);
  const { argv, env } = outcome.pi;
  const provider = argv.indexOf('--provider');
  assert.deepEqual(argv.slice(provider, provider + 4), [
    '--provider',
    'anthropic',
    '--model',
    'claude-opus-5-5',
  ]);
  assert.equal(outcome.bwrap.env.ANTHROPIC_OAUTH_TOKEN, ANTHROPIC_TOKEN);
  assert.equal('OPENROUTER_API_KEY' in outcome.bwrap.env, false);
  assert.equal('OPENROUTER_API_KEY' in env, false);
  assert.equal(outcome.pi.modelsJson, null);
  assert.equal(outcome.openRouterRequests, 0);
  assert.equal(outcome.run.status, 'success');
});

test('given a subscription workload whose agent echoes the token in a command and in its reply, when the transcript, raw events and request record are written, then the token reaches none of them', async () => {
  const outcome = await runWorker(
    subscriptionScenario('anthropic-success.jsonl', {
      output: outputFile(
        readFileSync(fixture('anthropic-success.jsonl'), 'utf8')
          .replaceAll('echo forge', `echo ${ANTHROPIC_TOKEN}`)
          .replaceAll('All done.', `The token is ${ANTHROPIC_TOKEN}.`),
      ),
      requests: outputOf([
        {
          type: 'request',
          body: { system: [{ type: 'text', text: ANTHROPIC_TOKEN }] },
          cacheMarkers: [],
        },
      ]),
    }),
  );

  assert.doesNotMatch(outcome.transcript, /sk-ant-oat/);
  assert.doesNotMatch(JSON.stringify(outcome.rawEvents), /sk-ant-oat/);
  assert.doesNotMatch(JSON.stringify(outcome.requestRecord), /sk-ant-oat/);
  assert.match(outcome.transcript, /redacted/);
});

test('given workers on openrouter and on anthropic, when each runs with both credentials in the runner environment, then each sandbox holds only its own provider\'s credential', async () => {
  const openRouter = await runWorker({
    output: fixture('success.jsonl'),
    anthropicToken: ANTHROPIC_TOKEN,
  });
  const anthropic = await runWorker(
    subscriptionScenario('anthropic-success.jsonl'),
  );

  assert.equal(openRouter.bwrap.env.OPENROUTER_API_KEY, OPENROUTER_KEY);
  assert.equal('ANTHROPIC_OAUTH_TOKEN' in openRouter.bwrap.env, false);
  assert.equal(anthropic.bwrap.env.ANTHROPIC_OAUTH_TOKEN, ANTHROPIC_TOKEN);
  assert.equal('OPENROUTER_API_KEY' in anthropic.bwrap.env, false);
});

test('given a subscription workload with two generations, when it finishes and the billing service fires, then its cost status is subscription with no cost, its generations carry Anthropic\'s message ids and tokens, and billing neither looks up nor changes any of them', async () => {
  const openRouter = await fakeOpenRouter(billed);
  try {
    const outcome = await runWorker(subscriptionScenario('anthropic-success.jsonl'));
    const before = storedGenerations(outcome.stateDir, outcome.run.id);
    assert.equal(await fire(outcome.stateDir, openRouter), 0);
    const after = storedGenerations(outcome.stateDir, outcome.run.id);
    const run = storedRun(outcome.stateDir, outcome.run.id);

    assert.deepEqual(openRouter.lookups, []);
    assert.deepEqual(after, before);
    assert.deepEqual(
      after.map(({ generationId }) => generationId),
      ['msg_forge_success_1', 'msg_forge_success_2'],
    );
    assert.deepEqual(
      after.map(({ billedCostUsd, estimatedCostUsd, attempts }) => [
        billedCostUsd,
        estimatedCostUsd,
        attempts,
      ]),
      [
        [null, null, 0],
        [null, null, 0],
      ],
    );
    const listPriceEquivalents = after.map(
      ({ listPriceEquivalentUsd }) => listPriceEquivalentUsd,
    );
    assert.deepEqual(
      listPriceEquivalents.map((usd) => Number(usd?.toFixed(9))),
      [0.0066, 0.0031],
    );
    assert.equal(run.costStatus, 'subscription');
    assert.equal(run.costUsd, 0);
    assert.equal(run.costEstimated, false);
    assert.equal(run.inputTokens, 500);
    assert.equal(run.outputTokens, 65);
    assert.equal(run.cacheReadTokens, 1000);
    assert.equal(run.cacheWriteTokens, 1200);
  } finally {
    openRouter.close();
  }
});

test('given a subscription workload whose agent spawns a subagent, when it runs, then the subagent is started on the anthropic provider and the workload\'s model, its generations belong to the workload under their scope, and the workload stays subscription', async () => {
  const outcome = await runWorker(subscriptionScenario('anthropic-subagent.jsonl'));

  const invocation = JSON.parse(outcome.pi.subagentInvocation ?? '') as {
    argv: string[];
  };
  const provider = invocation.argv.indexOf('--provider');
  assert.deepEqual(invocation.argv.slice(provider, provider + 4), [
    '--provider',
    'anthropic',
    '--model',
    'claude-opus-5-5',
  ]);
  assert.equal(outcome.bwrap.env.ANTHROPIC_OAUTH_TOKEN, ANTHROPIC_TOKEN);
  const generations = storedGenerations(outcome.stateDir, outcome.run.id);
  assert.ok(generations.some(({ subagent }) => subagent !== null));
  assert.ok(generations.some(({ subagent }) => subagent === null));
  assert.ok(
    generations.every(({ generationId }) => generationId?.startsWith('msg_forge_')),
  );
  assert.equal(outcome.run.costStatus, 'subscription');
});

test('given a subscription workload whose provider answers with a usage limit asking for a retry after hours, when pi gives up after its retries, then the workload ends error with Anthropic\'s message and the runner exits as for a failure', async () => {
  const outcome = await runWorker(
    subscriptionScenario('anthropic-usage-limit.jsonl'),
  );

  assert.equal(outcome.code, 1);
  assert.equal(outcome.run.status, 'error');
  assert.match(outcome.run.error ?? '', /You've hit your limit - resets 4pm/);
  assert.equal(outcome.run.costStatus, 'subscription');
});

test('given a subscription worker whose budget the first generation\'s list-price equivalent passes and a pi that keeps running, when it runs, then pi is killed and the run ends exceeded on its budget', async () => {
  const { code, run, pi } = await runWorker(
    subscriptionScenario('anthropic-success.jsonl', {
      lingerMs: 10_000,
      worker: { ...SUBSCRIPTION_WORKER, maxCostUsd: 0.005 },
    }),
  );

  assert.equal(code, 1);
  assert.equal(run.status, 'exceeded');
  assert.equal(run.exceededLimit, 'budget');
  assert.equal(run.maxCostUsd, 0.005);
  assert.equal(isAlive(pi.pid), false);
});

test('given a subscription worker with a budget its list-price equivalents stay under, when it runs, then the workload succeeds', async () => {
  const { code, run } = await runWorker(
    subscriptionScenario('anthropic-success.jsonl', {
      worker: { ...SUBSCRIPTION_WORKER, maxCostUsd: 1 },
    }),
  );

  assert.equal(code, 0);
  assert.equal(run.status, 'success');
});

test('given a budgeted subscription worker whose model pi\'s catalog cannot price, when it runs, then pi never starts and the run ends error saying the model could not be priced', async () => {
  const outcome = await runWorker(
    subscriptionScenario('anthropic-success.jsonl', {
      worker: { ...SUBSCRIPTION_WORKER, model: 'claude-unpriced', maxCostUsd: 5 },
    }),
  );

  assert.equal(outcome.code, 1);
  assert.equal(outcome.piStarted, false);
  assert.equal(outcome.run.status, 'error');
  assert.match(outcome.run.error ?? '', /claude-unpriced.*could not be priced/);
  assert.equal(outcome.openRouterRequests, 0);
});

test('given an unbudgeted subscription worker whose model pi\'s catalog cannot price, when it runs, then the workload runs with no list-price equivalent', async () => {
  const outcome = await runWorker(
    subscriptionScenario('anthropic-success.jsonl', {
      worker: { ...SUBSCRIPTION_WORKER, model: 'claude-unpriced', maxCostUsd: null },
    }),
  );

  assert.equal(outcome.code, 0);
  assert.deepEqual(
    storedGenerations(outcome.stateDir, outcome.run.id).map(
      ({ listPriceEquivalentUsd }) => listPriceEquivalentUsd,
    ),
    [null, null],
  );
});

test('given a worker on anthropic and one on openrouter otherwise identical, when each runs, then only the anthropic fingerprint carries its provider and the two hash apart', async () => {
  const run = async (worker: Partial<WorkerConfig>, anthropic: boolean) => {
    const outcome = await runWorker(
      anthropic
        ? subscriptionScenario('anthropic-success.jsonl', {
            requests: requestsOf('h-system'),
            worker: { ...worker, ...SUBSCRIPTION_WORKER },
          })
        : { output: fixture('success.jsonl'), requests: requestsOf('h-system'), worker },
    );
    return withStore(outcome.stateDir, (store) => store.getFingerprint(outcome.run.id));
  };

  const subscription = await run({ model: 'claude-opus-5-5' }, true);
  const billedRun = await run({ model: 'claude-opus-5-5' }, false);

  assert.equal(subscription?.fingerprint.provider, 'anthropic');
  assert.equal('provider' in (billedRun?.fingerprint ?? {}), false);
  assert.notEqual(subscription?.hash, billedRun?.hash);
});
