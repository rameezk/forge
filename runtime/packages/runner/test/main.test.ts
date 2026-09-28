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

interface Scenario {
  output: string;
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

  const code = await main(['refiner'], {
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
  });

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

test('given recorded pi output of a successful multi-message run with tool, turn and streaming events, when the worker runs, then the events forge does not consume are skipped and the run is success with summed full-prompt usage, the session id, a readable transcript, and cost flagged uncertain', async () => {
  const output = fixture('success.jsonl');

  const { code, run, transcript } = await runWorker({ output });

  assert.equal(code, 0);
  assert.equal(run.status, 'success');
  assert.equal(run.error, null);
  assert.equal(run.inputTokens, 1200 + 1300);
  assert.equal(run.outputTokens, 40 + 25);
  assert.equal(run.sessionId, sessionIdOf(output));
  assert.equal(run.costUsd, 0);
  assert.equal(run.costUncertain, true);
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

test('given recorded pi output where a failed attempt is retried and then succeeds, when the worker runs, then the run is success and its tokens include the failed attempt', async () => {
  const { code, run } = await runWorker({ output: fixture('retry.jsonl') });

  assert.equal(code, 0);
  assert.equal(run.status, 'success');
  assert.equal(run.inputTokens, 900 + 900);
  assert.equal(run.outputTokens, 3 + 8);
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
