import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { claudeCodeArgs, claudeCodeEnv } from '../../src/claude-code.ts';
import {
  CLAUDE_TOKEN,
  claudeScenarios,
  serveMessages,
  type ClaudeScenario,
} from './fake-anthropic.ts';

const PROMPT = 'Run echo forge, then say what it printed.';

const record = async (
  claude: string,
  name: string,
  { respond }: ClaudeScenario,
  outDir: string,
): Promise<void> => {
  const server = await serveMessages(respond);
  const { port } = server.address() as AddressInfo;
  const work = mkdtempSync(join(tmpdir(), 'forge-record-work-'));
  const config = mkdtempSync(join(tmpdir(), 'forge-record-config-'));
  const home = mkdtempSync(join(tmpdir(), 'forge-record-home-'));
  const bodies = mkdtempSync(join(tmpdir(), 'forge-record-bodies-'));
  const args = claudeCodeArgs(
    { workDir: work, model: 'claude-opus-4-5', prompt: PROMPT },
    { maxCostUsd: null, extraArgs: [] },
  );
  const child = spawn(claude, args, {
    cwd: work,
    env: claudeCodeEnv(
      {
        PATH: process.env.PATH ?? '',
        HOME: home,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN,
      },
      config,
      bodies,
    ),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data: Buffer) => (stdout += data.toString()));
  child.stderr.on('data', (data: Buffer) => (stderr += data.toString()));
  const [code] = (await once(child, 'close')) as [number | null];
  server.close();
  const target = join(outDir, name);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'stream.jsonl'), stdout);
  writeFileSync(join(target, 'stderr.txt'), stderr);
  writeFileSync(join(target, 'exit.txt'), `${String(code)}\n`);
  for (const file of readdirSync(bodies)) {
    if (!file.endsWith('.request.json')) {
      mkdirSync(join(target, 'bodies'), { recursive: true });
      cpSync(join(bodies, file), join(target, 'bodies', file));
    }
  }
};

const claude = process.argv[2];
if (claude === undefined) {
  console.error('usage: node record-claude-code.ts <path-to-claude>');
  process.exit(1);
}
const outDir = join(dirname(import.meta.filename), 'claude-code');
for (const [name, scenario] of Object.entries(claudeScenarios)) {
  await record(claude, name, scenario, outDir);
}
