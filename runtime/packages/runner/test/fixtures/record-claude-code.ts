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
  { respond, prompt = PROMPT, files = {} }: ClaudeScenario,
  outDir: string,
): Promise<void> => {
  const server = await serveMessages(respond);
  const { port } = server.address() as AddressInfo;
  const work = mkdtempSync(join(tmpdir(), 'forge-record-work-'));
  const config = mkdtempSync(join(tmpdir(), 'forge-record-config-'));
  const home = mkdtempSync(join(tmpdir(), 'forge-record-home-'));
  const bodies = mkdtempSync(join(tmpdir(), 'forge-record-bodies-'));
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), contents);
  }
  const child = spawn(
    claude,
    [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--dangerously-skip-permissions',
      '--model',
      'claude-opus-4-5',
      prompt,
    ],
    {
      cwd: work,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        CLAUDE_CONFIG_DIR: config,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN,
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_LOGS_EXPORTER: 'none',
        OTEL_LOG_RAW_API_BODIES: `file:${bodies}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
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
