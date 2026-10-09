import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { childArgs, SUBAGENT_INVOCATION_ENV } from '@forge/pi-subagent';
import type { HarnessInvocation } from '../../src/harness.ts';
import { piArgs, subagentInvocation } from '../../src/pi.ts';
import { providerSpec } from '../../src/provider.ts';
import { REQUEST_RECORD_FD_ENV } from '@forge/pi-request-record';
import { REQUEST_RECORD_FD } from '../../src/sandbox.ts';
import { PI_EXTENSIONS } from '../helpers.ts';
import {
  ANTHROPIC_TOKEN,
  anthropicScenarios,
  childScenarios,
  serve,
  SUBAGENT_TASKS,
  scenarios,
  type Respond,
} from './fake-provider.ts';

const INVOCATION: HarnessInvocation = {
  agentDir: '/nix/store/00000000000000000000000000000000-pi-agent-dir',
  provider: 'openrouter',
  model: 'z-ai/glm-5',
  prompt: 'Run echo forge, then say what it printed.',
  workDir: '.',
  reasoningEffort: 'high',
};

const ANTHROPIC_INVOCATION: HarnessInvocation = {
  ...INVOCATION,
  provider: 'anthropic',
  model: 'claude-opus-5-5',
};

const runPi = async (
  pi: string,
  invocation: HarnessInvocation,
  baseUrl: string,
  key: string | undefined,
  args: string[],
  files: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> => {
  const home = mkdtempSync(join(tmpdir(), 'forge-record-home-'));
  const work = mkdtempSync(join(tmpdir(), 'forge-record-work-'));
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), contents);
  }
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
  writeFileSync(
    join(home, '.pi', 'agent', 'models.json'),
    JSON.stringify({
      providers: { [providerSpec(invocation.provider).piName]: { baseUrl } },
    }),
  );
  writeFileSync(
    join(home, '.pi', 'agent', 'settings.json'),
    JSON.stringify({ compaction: { keepRecentTokens: 1 } }),
  );
  const child = spawn(pi, args, {
    cwd: work,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      [REQUEST_RECORD_FD_ENV]: String(REQUEST_RECORD_FD),
      [SUBAGENT_INVOCATION_ENV]: JSON.stringify(
        subagentInvocation(pi, invocation, PI_EXTENSIONS),
      ),
      ...(key === undefined
        ? {}
        : { [providerSpec(invocation.provider).credentialEnv]: key }),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore'],
  }) as ChildProcessByStdio<null, Readable, Readable>;
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data: Buffer) => (stdout += data.toString()));
  child.stderr.on('data', (data: Buffer) => (stderr += data.toString()));
  const [code] = (await once(child, 'close')) as [number | null];
  return { stdout, stderr, code };
};

const recordRun = async (
  pi: string,
  invocation: HarnessInvocation,
  respond: Respond,
  args: string[],
  out: string,
  files: Record<string, string> = {},
): Promise<void> => {
  const server = await serve(respond);
  const { port } = server.address() as AddressInfo;
  const run = await runPi(
    pi,
    invocation,
    invocation.provider === 'anthropic'
      ? `http://127.0.0.1:${port}`
      : `http://127.0.0.1:${port}/v1`,
    invocation.provider === 'anthropic' ? ANTHROPIC_TOKEN : 'sk-fake',
    args,
    files,
  );
  server.close();
  if (run.code !== 0) {
    throw new Error(`${out}: pi exited ${String(run.code)}: ${run.stderr}`);
  }
  writeFileSync(out, run.stdout);
};

const record = async (
  pi: string,
  outDir: string,
  childOutDir: string,
): Promise<void> => {
  mkdirSync(childOutDir, { recursive: true });
  for (const [name, respond] of Object.entries(childScenarios)) {
    await recordRun(
      pi,
      INVOCATION,
      respond,
      childArgs(
        subagentInvocation(pi, INVOCATION, PI_EXTENSIONS),
        SUBAGENT_TASKS.alpha,
      ),
      join(childOutDir, `${name}.jsonl`),
    );
  }

  mkdirSync(outDir, { recursive: true });
  for (const [
    name,
    { respond, prompt = INVOCATION.prompt, files },
  ] of Object.entries(scenarios)) {
    await recordRun(
      pi,
      INVOCATION,
      respond,
      piArgs({ ...INVOCATION, prompt }, PI_EXTENSIONS),
      join(outDir, `${name}.jsonl`),
      files,
    );
  }
  for (const [
    name,
    { respond, prompt = INVOCATION.prompt, files },
  ] of Object.entries(anthropicScenarios)) {
    await recordRun(
      pi,
      ANTHROPIC_INVOCATION,
      respond,
      piArgs({ ...ANTHROPIC_INVOCATION, prompt }, PI_EXTENSIONS),
      join(outDir, `${name}.jsonl`),
      files,
    );
  }
  const preflight = await runPi(
    pi,
    INVOCATION,
    'http://127.0.0.1:9/v1',
    undefined,
    piArgs(INVOCATION, PI_EXTENSIONS),
  );
  writeFileSync(join(outDir, 'preflight.jsonl'), preflight.stdout);
  writeFileSync(join(outDir, 'preflight.stderr'), preflight.stderr);
};

const pi = process.argv[2];
if (pi === undefined) {
  console.error('usage: node record-pi.ts <path-to-pi>');
  process.exit(1);
}
await record(
  pi,
  join(dirname(import.meta.filename), 'pi'),
  join(PI_EXTENSIONS.subagent, '..', 'test', 'fixtures'),
);
