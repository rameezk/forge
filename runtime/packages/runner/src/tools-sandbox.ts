import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolsConfig } from './environment.ts';
import { spawnSandboxed, type Sandbox } from './sandbox.ts';

export interface ToolsSandbox {
  dir: string;
  exited: Promise<Error | null>;
  stop: () => Promise<void>;
}

export const startToolsSandbox = ({
  sandbox,
  tools,
  workDir,
  env,
  withheld,
}: {
  sandbox: Sandbox;
  tools: ToolsConfig;
  workDir: string;
  env: Record<string, string>;
  withheld: string[];
}): ToolsSandbox => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-tools-'));
  const { child, stdout, requestRecord, exited } = spawnSandboxed(
    sandbox,
    tools.broker,
    withheld.flatMap((name) => ['--withhold', name]),
    {
      name: 'the command broker',
      workDir,
      env,
      broker: { dir, role: 'tools' },
    },
  );
  stdout.resume();
  requestRecord.resume();
  return {
    dir,
    exited,
    stop: async () => {
      child.kill('SIGKILL');
      await exited;
      rmSync(dir, { recursive: true, force: true });
    },
  };
};
