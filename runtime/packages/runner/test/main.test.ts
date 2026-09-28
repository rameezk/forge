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
import { Store, type RunRecord } from '@forge/shared';
import type { WorkerConfig } from '../src/index.ts';
import { main } from '../src/main.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'pi');

const fixture = (name: string): string => join(FIXTURES, name);

const FAKE_PI = `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const env = process.env;
writeFileSync(env.FAKE_PI_RECORD, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid }));
process.stdout.write(readFileSync(env.FAKE_PI_OUTPUT, 'utf8'));
if (env.FAKE_PI_STDERR) process.stderr.write(readFileSync(env.FAKE_PI_STDERR, 'utf8'));
process.exitCode = Number(env.FAKE_PI_EXIT ?? '0');
if (env.FAKE_PI_LINGER_MS) setTimeout(() => {}, Number(env.FAKE_PI_LINGER_MS));
`;

type GenerationStats = (
  id: string,
  attempt: number,
) => { status: number; body?: unknown } | 'hang';

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
};

const OPENROUTER_KEY = 'sk-or-test';

interface Lookup {
  id: string | null;
  authorization: string | undefined;
}

const fakeOpenRouter = async (
  generations: GenerationStats,
): Promise<{ baseUrl: string; lookups: Lookup[]; close: () => void }> => {
  const lookups: Lookup[] = [];
  const attempts = new Map<string, number>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake');
    const id = url.searchParams.get('id');
    lookups.push({ id, authorization: request.headers.authorization });
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
    const { status, body } = reply;
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(typeof body === 'string' ? body : JSON.stringify(body ?? ''));
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
  pi: { argv: string[]; cwd: string; pid: number };
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
    OPENROUTER_API_KEY: OPENROUTER_KEY,
    FORGE_RUNTIME_CONFIG: configPath,
    FORGE_STATE_DIR: stateDir,
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

const cutBefore = (name: string, eventType: string): string => {
  const lines = readFileSync(fixture(name), 'utf8').split('\n');
  const cut = lines.findIndex((line) => line.includes(`"type":"${eventType}"`));
  assert.ok(cut > 0);
  return outputFile(`${lines.slice(0, cut).join('\n')}\n`);
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
  assert.equal(run.costUncertain, false);
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

test('given workers with and without a reasoning effort and a harness with operator extras, when each runs, then pi receives the json, no-session, offline, openrouter contract with the plain model, the extras, the prompt last, and a thinking level only when declared', async () => {
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
    '--no-skills',
    'refine the spec',
  ]);
  assert.deepEqual(withoutEffort.pi.argv, [
    ...contract,
    '--no-skills',
    'refine the spec',
  ]);
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

test('given recorded pi output ending in a provider error and pi exiting 0, when the worker runs, then the run is error with pi error message and the runner exits non-zero', async () => {
  const { code, run } = await runWorker({
    output: fixture('provider-error.jsonl'),
  });

  assert.equal(code, 1);
  assert.equal(run.status, 'error');
  assert.equal(run.error, '400 z-ai/glm-5 is not a valid model ID');
});

test('given recorded pi output where a failed attempt is retried and then succeeds, and an OpenRouter billing every generation, when the worker runs, then the run is success and its tokens and billed cost include the failed attempt', async () => {
  const { code, run } = await runWorker({ output: fixture('retry.jsonl') });

  assert.equal(code, 0);
  assert.equal(run.status, 'success');
  assert.equal(run.inputTokens, 900 + 900);
  assert.equal(run.outputTokens, 3 + 8);
  assert.equal(run.costUsd, 0.002 + 0.004);
  assert.equal(run.costUncertain, false);
});

test('given pi failing pre-flight with its reason on stderr and exit 1, when the worker runs, then the run is error carrying that reason and stderr still reaches the journal', async () => {
  const journal: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    journal.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  const outcome = await runWorker({
    output: fixture('preflight.jsonl'),
    stderr: fixture('preflight.stderr'),
    exit: 1,
  }).finally(() => {
    process.stderr.write = write;
  });

  assert.equal(outcome.code, 1);
  assert.equal(outcome.run.status, 'error');
  assert.match(outcome.run.error ?? '', /No API key found for openrouter\./);
  assert.equal(outcome.run.sessionId, sessionIdOf(fixture('preflight.jsonl')));
  assert.match(journal.join(''), /No API key found for openrouter\./);
});

test('given pi output that is cut off before a final agent_end, or that ends on an agent_end that will retry, when the worker runs, then the run is error', async () => {
  for (const output of [
    cutBefore('success.jsonl', 'agent_end'),
    cutBefore('retry.jsonl', 'auto_retry_start'),
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

test('given a successful recorded run and an OpenRouter that keeps failing one generation lookup, with a server error, an unusable body, a not found that never clears, or no answer at all, when the worker runs, then the run stays success with the cost it could look up and cost flagged uncertain', async () => {
  const failures: ReturnType<GenerationStats>[] = [
    { status: 500, body: { error: { code: 500 } } },
    { status: 200, body: { data: { id: 'gen-success-2' } } },
    { status: 200, body: 'not json' },
    { status: 404, body: { error: { code: 404 } } },
    'hang',
  ];

  const outcomes = await Promise.all(
    failures.map((failure) =>
      runWorker({
        output: fixture('success.jsonl'),
        generations: (id, attempt) =>
          id === 'gen-success-2'
            ? failure
            : billedAt(BILLED_BY_ID)(id, attempt),
      }),
    ),
  );

  for (const { code, run } of outcomes) {
    assert.equal(code, 0);
    assert.equal(run.status, 'success');
    assert.equal(run.error, null);
    assert.equal(run.costUsd, 0.0125);
    assert.equal(run.costUncertain, true);
  }
});

test('given an OpenRouter whose stats for a generation lag, returning not found at first and then its billed cost, when the worker runs, then the run cost includes that generation and is not flagged uncertain', async () => {
  const { run, lookups } = await runWorker({
    output: fixture('success.jsonl'),
    generations: (id, attempt) =>
      id === 'gen-success-2' && attempt < 3
        ? billedAt({})(id, attempt)
        : billedAt(BILLED_BY_ID)(id, attempt),
  });

  assert.equal(run.status, 'success');
  assert.equal(run.costUsd, 0.0125 + 0.0375);
  assert.equal(run.costUncertain, false);
  assert.equal(
    lookups.filter((lookup) => lookup.id === 'gen-success-2').length,
    3,
  );
});

test('given a successful recorded run and an OpenRouter base URL that is not a valid URL, when the worker runs, then the run stays success and exits zero with cost flagged uncertain', async () => {
  const { code, run } = await runWorker({
    output: fixture('success.jsonl'),
    openRouterBaseUrl: 'openrouter.ai/api/v1',
  });

  assert.equal(code, 0);
  assert.equal(run.status, 'success');
  assert.equal(run.error, null);
  assert.equal(run.costUsd, 0);
  assert.equal(run.costUncertain, true);
});
