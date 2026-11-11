import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type DiagnosisRecord, type RunRecord } from '@forge/shared';
import { main } from '../src/diagnose-main.ts';
import { APP_ID, fakeGithubApp, routedThrough, tokenFor } from '../../shared/test/fixtures/fake-github-app.ts';
import {
  billedAt,
  brokerEnv,
  fakeOpenRouter,
  lockedPiPackage,
  PI_EXTENSIONS,
  startedDispatch,
  writeFakeBwrap,
  writeFakePi,
} from './helpers.ts';

const PI_OUTPUT = join(import.meta.dirname, 'fixtures', 'pi', 'success.jsonl');

const VERDICT = JSON.stringify({
  category: 'skill',
  evidence: [{ turn: 2, note: 'the worker never opened the skill it was told to run' }],
  suggestedFix: 'Make the skill say which file to edit',
});

interface PiCall {
  argv: string[];
  cwd: string;
  githubTokenFileContents: string | null;
  env: Record<string, string>;
}

interface BwrapCall {
  argv: string[];
}

const failedRun = (id: string): RunRecord => ({
  id,
  worker: 'builder',
  harness: 'pi',
  model: 'z-ai/glm-5',
  reasoningEffort: null,
  startTime: '2026-11-01T10:00:00.000Z',
  endTime: '2026-11-01T10:30:00.000Z',
  status: 'success',
  costStatus: 'billed',
  costUsd: 1,
  costEstimated: false,
  unconfirmedEstimateUsd: 0,
  listPrice: null,
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  transcriptRef: `${id}.jsonl`,
  sessionId: null,
  error: null,
  ticket: { repository: 'forge', number: 31, url: 'https://github.com/rameezk/forge/issues/31' },
  aliveAt: null,
  harnessStartTime: '2026-11-01T10:00:01.000Z',
  timeoutSeconds: null,
  maxCostUsd: null,
  exceededLimit: null,
  counters: null,
});

interface Scenario {
  action?: string;
  configured?: boolean;
}

const diagnose = async ({ action, configured = true }: Scenario = {}) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'forge-diagnose-'));
  const record = join(stateDir, 'pi-call.json');
  const bwrapRecord = join(stateDir, 'bwrap-call.json');
  const configPath = join(stateDir, 'runtime.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      harnesses: { pi: { command: writeFakePi(stateDir) } },
      workers: {
        builder: { harness: 'pi', model: 'z-ai/glm-5', prompt: '/work-on {url}' },
        diagnoser: { harness: 'pi', model: 'z-ai/glm-5', prompt: 'Look for the first wrong turn.' },
      },
      repositories: { forge: { github: 'rameezk/forge', on: { ticket: 'builder' } } },
      ...(configured ? { diagnosis: { worker: 'diagnoser' } } : {}),
    }),
  );
  mkdirSync(join(stateDir, 'transcripts'), { recursive: true });
  mkdirSync(join(stateDir, 'work', 'failed-run'), { recursive: true });
  writeFileSync(join(stateDir, 'transcripts', 'failed-run.jsonl'), '{"type":"message"}\n');
  writeFileSync(join(stateDir, 'transcripts', 'failed-run.requests.jsonl'), '{}\n');
  writeFileSync(join(stateDir, 'work', 'failed-run', 'notes.txt'), 'left behind\n');
  const at = new Date().toISOString();
  const seeded = Store.open(join(stateDir, 'forge.db'));
  try {
    seeded.insertRun(failedRun('failed-run'));
    const id = startedDispatch(seeded, 'forge', 31, 'failed-run', at);
    seeded.endDispatch(id, { state: 'failed', reason: 'check-failed', detail: 'build, lint' }, at);
    seeded.startDiagnosis('failed-run', 'diagnosis-run', at);
  } finally {
    seeded.close();
  }
  const app = fakeGithubApp(['rameezk/forge']);
  const privateKeyFile = join(stateDir, 'github-app-private-key');
  writeFileSync(privateKeyFile, app.privateKey);
  const openRouter = await fakeOpenRouter(billedAt({}), null);
  const fetch = routedThrough(app, async () => new Response('{}'));
  const complain = console.error;
  console.error = () => undefined;
  let thrown: string | null = null;
  const code = await main(
    ['diagnosis-run'],
    {
      PATH: process.env.PATH,
      HOME: stateDir,
      FORGE_NIX_SYSTEM: 'x86_64-linux',
      FORGE_RUNTIME_CONFIG: configPath,
      FORGE_STATE_DIR: stateDir,
      FORGE_PI_SUBAGENT_EXTENSION: PI_EXTENSIONS.subagent,
      FORGE_PI_MODEL_DEFAULT_REASONING_EXTENSION: PI_EXTENSIONS.modelDefaultReasoning,
      FORGE_PI_REQUEST_RECORD_EXTENSION: PI_EXTENSIONS.requestRecord,
      FORGE_PI_PACKAGE: lockedPiPackage(),
      ...brokerEnv(stateDir),
      FORGE_BWRAP: writeFakeBwrap(stateDir, {
        record: bwrapRecord,
        harnessEnv: {
          FAKE_PI_RECORD: record,
          FAKE_PI_OUTPUT: PI_OUTPUT,
          ...(action === undefined ? {} : { FAKE_PI_ACTION: action }),
        },
      }),
      FORGE_GITHUB_APP_ID: APP_ID,
      FORGE_GITHUB_APP_PRIVATE_KEY_FILE: privateKeyFile,
      OPENROUTER_API_KEY: 'sk-or-test',
      OPENROUTER_BASE_URL: openRouter.baseUrl,
    },
    fetch,
  )
    .catch((error: unknown) => {
      thrown = error instanceof Error ? error.message : String(error);
      return 1;
    })
    .finally(() => {
      console.error = complain;
      return openRouter.close();
    });
  const store = Store.open(join(stateDir, 'forge.db'));
  try {
    const now = new Date().toISOString();
    return {
      code,
      thrown,
      stateDir,
      diagnosis: store.diagnosisOfRun('diagnosis-run', now) as DiagnosisRecord,
      undiagnosed: store.undiagnosedFailures(),
      run: store.getRun('diagnosis-run'),
      pi: existsSync(record) ? (JSON.parse(readFileSync(record, 'utf8')) as PiCall) : null,
      tools: existsSync(`${bwrapRecord}.tools`) ? (JSON.parse(readFileSync(`${bwrapRecord}.tools`, 'utf8')) as BwrapCall) : null,
      bwrap: existsSync(bwrapRecord) ? (JSON.parse(readFileSync(bwrapRecord, 'utf8')) as BwrapCall) : null,
    };
  } finally {
    store.close();
  }
};

const writing = (contents: string): string => `printf '%s' '${contents}' > diagnosis.json`;

test('given a diagnosis whose agent writes a valid diagnosis.json with category skill, when the diagnosis ends, then it is done and carries the category, its evidence and the suggested fix', async () => {
  const { code, diagnosis, run } = await diagnose({ action: writing(VERDICT) });
  assert.equal(code, 0);
  assert.equal(diagnosis.state, 'done');
  assert.deepEqual(diagnosis.verdict, JSON.parse(VERDICT));
  assert.equal(run?.worker, 'diagnoser');
  assert.equal(run?.status, 'success');
});

test('given a diagnosis whose agent writes no diagnosis.json, when it ends, then the diagnosis fails naming the file, and no diagnosis starts for the failed diagnosis', async () => {
  const { code, diagnosis, undiagnosed } = await diagnose();
  assert.equal(code, 1);
  assert.equal(diagnosis.state, 'failed');
  assert.match(diagnosis.detail ?? '', /diagnosis\.json/);
  assert.equal(diagnosis.verdict, null);
  assert.deepEqual(undiagnosed, []);
});

test('given a diagnosis whose agent writes a diagnosis.json that breaks the contract, when it ends, then the diagnosis fails and says what was wrong', async () => {
  const { diagnosis } = await diagnose({ action: writing('{"category":"gremlins"}') });
  assert.equal(diagnosis.state, 'failed');
  assert.match(diagnosis.detail ?? '', /category must be one of/);
});

test('given no diagnosis worker is configured, when a diagnosis unit runs, then it refuses and the diagnosis fails saying so', async () => {
  const { thrown, diagnosis } = await diagnose({ configured: false });
  assert.match(thrown ?? '', /no diagnosis worker is configured/);
  assert.equal(diagnosis.state, 'failed');
});

test('given a failed dispatch whose run directory still exists, when its diagnosis runs, then the agent reads the failed run read-only, holds a read-only token and no write token, and gets only the base toolset', async () => {
  const { pi, bwrap, tools, stateDir } = await diagnose({ action: writing(VERDICT) });
  assert.ok(pi !== null && bwrap !== null && tools !== null);
  for (const sandbox of [bwrap, tools]) {
    const roBinds = sandbox.argv.flatMap((arg, index) =>
      arg === '--ro-bind' ? [sandbox.argv[index + 1] as string] : [],
    );
    const binds = sandbox.argv.flatMap((arg, index) => (arg === '--bind' ? [sandbox.argv[index + 1] as string] : []));
    for (const path of [
      join(stateDir, 'transcripts', 'failed-run.jsonl'),
      join(stateDir, 'transcripts', 'failed-run.requests.jsonl'),
      join(stateDir, 'work', 'failed-run'),
    ]) {
      assert.ok(roBinds.includes(path), `${path} is mounted read-only`);
      assert.ok(!binds.includes(path), `${path} is not mounted writable`);
    }
    assert.deepEqual(binds, [join(stateDir, 'work', 'diagnosis-run')]);
  }
  assert.equal(pi.cwd, join(stateDir, 'work', 'diagnosis-run'));
  assert.equal(pi.githubTokenFileContents, tokenFor('read', 'rameezk/forge'));
  assert.ok(!JSON.stringify(pi.env).includes('ghs_workload'));
  assert.ok(!JSON.stringify(pi.env).includes('ghs_write'));
  assert.ok(!pi.argv.includes('--skill'));
});

test('given a failure to diagnose, when the agent starts, then the standing instruction carries the contract and the untrusted-input warning, and the failure is in the first user message with the worker prompt first', async () => {
  const { pi } = await diagnose({ action: writing(VERDICT) });
  const instruction = (pi?.argv ?? [])
    .filter((_, index) => pi?.argv[index - 1] === '--append-system-prompt')
    .join('\n');
  assert.match(instruction, /untrusted/i);
  assert.match(instruction, /diagnosis\.json/);
  for (const category of ['worker', 'skill', 'ticket-or-spec', 'repository-environment', 'forge', 'provider-and-infra', 'unclear']) {
    assert.ok(instruction.includes(category), category);
  }
  assert.doesNotMatch(instruction, /rameezk|forge:ready/);
  assert.doesNotMatch(instruction, /failed-run|check-failed/);
  const message = pi?.argv.at(-1) ?? '';
  assert.ok(message.startsWith('Look for the first wrong turn.'));
  assert.match(message, /failed-run/);
  assert.match(message, /check-failed/);
  assert.match(message, /build, lint/);
});

test('given a diagnosis.json that is a symlink, or larger than the contract allows, when the diagnosis ends, then it fails without reading it', async () => {
  const linked = await diagnose({ action: `printf '%s' '${VERDICT}' > elsewhere.json && ln -s elsewhere.json diagnosis.json` });
  assert.equal(linked.diagnosis.state, 'failed');
  assert.match(linked.diagnosis.detail ?? '', /diagnosis\.json/);
  const large = await diagnose({ action: `head -c 100000 /dev/zero | tr '\\0' 'a' > diagnosis.json` });
  assert.equal(large.diagnosis.state, 'failed');
  assert.match(large.diagnosis.detail ?? '', /diagnosis\.json/);
});
