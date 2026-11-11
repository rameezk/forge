import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolsConfig } from './environment.ts';
import { SandboxUnavailable, spawnSandboxed, type Sandbox } from './sandbox.ts';

export interface ToolsSandbox {
  dir: string;
  ready: Promise<void>;
  exited: Promise<Error | null>;
  stop: () => Promise<void>;
}

export const startToolsSandbox = ({
  sandbox,
  tools,
  workDir,
  readOnlyPaths,
  env,
  withheld,
  writableDirs,
}: {
  sandbox: Sandbox;
  tools: ToolsConfig;
  workDir: string;
  readOnlyPaths?: string[];
  env: Record<string, string>;
  withheld: string[];
  writableDirs?: string[];
}): ToolsSandbox => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-tools-'));
  const { child, stdout, exited } = spawnSandboxed(
    sandbox,
    tools.broker,
    withheld.flatMap((name) => ['--withhold', name]),
    {
      name: 'the command broker',
      workDir,
      ...(writableDirs === undefined ? {} : { writableDirs }),
      ...(readOnlyPaths === undefined ? {} : { readOnlyPaths }),
      env,
      broker: { dir, role: 'tools' },
      prefix: [tools.broker, '--prelisten', join(dir, 'broker.sock'), '--'],
    },
  );
  const ready = new Promise<void>((resolve, reject) => {
    stdout.once('data', () => resolve());
    void exited.then((failure) =>
      reject(
        failure instanceof SandboxUnavailable
          ? failure
          : new Error(
              `the tools sandbox ended before its command broker was ready${failure === null ? '' : `: ${failure.message}`}`,
            ),
      ),
    );
  });
  ready.catch(() => {});
  return {
    dir,
    ready,
    exited,
    stop: async () => {
      child.kill('SIGKILL');
      await exited;
      rmSync(dir, { recursive: true, force: true });
    },
  };
};
