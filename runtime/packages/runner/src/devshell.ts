import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { spawnSandboxed, type Sandbox } from './sandbox.ts';

export type DevShell = Record<string, string>;

const IGNORED_VARIABLES = new Set([
  'BASHOPTS',
  'HOME',
  'NIX_BUILD_TOP',
  'NIX_ENFORCE_PURITY',
  'NIX_LOG_FD',
  'NIX_REMOTE',
  'PPID',
  'SHELLOPTS',
  'SSL_CERT_FILE',
  'TEMP',
  'TEMPDIR',
  'TERM',
  'TMP',
  'TMPDIR',
  'TZ',
  'UID',
]);

const STDERR_TAIL_CHARS = 4000;

const PRINTED_EXCERPT_CHARS = 200;

export class DevShellFailed extends Error {}

const collect = (stream: Readable): Promise<string> =>
  new Promise((resolve) => {
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      text += chunk;
    });
    stream.on('close', () => resolve(text));
  });

const tailOf = (stream: Readable): Promise<string> =>
  new Promise((resolve) => {
    let tail = '';
    stream.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      tail = (tail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
    });
    stream.on('close', () => resolve(tail.trim()));
  });

const variablesOf = (printed: string): Record<string, { type: string; value: unknown }> => {
  try {
    const { variables } = JSON.parse(printed) as { variables: unknown };
    if (typeof variables === 'object' && variables !== null) {
      return variables as Record<string, { type: string; value: unknown }>;
    }
  } catch {}
  throw new DevShellFailed(
    `nix print-dev-env printed no dev environment: ${printed.slice(0, PRINTED_EXCERPT_CHARS)}`,
  );
};

const exportedVariables = (printed: string): DevShell =>
  Object.fromEntries(
    Object.entries(variablesOf(printed)).flatMap(([name, { type, value }]) =>
      type === 'exported' && typeof value === 'string' && !IGNORED_VARIABLES.has(name)
        ? [[name, value]]
        : [],
    ),
  );

export const enterDevShell = async ({
  sandbox,
  system,
  root,
  env,
}: {
  sandbox: Sandbox;
  system: string;
  root: string;
  env: Record<string, string>;
}): Promise<DevShell | undefined> => {
  if (!existsSync(join(root, 'flake.nix'))) {
    return undefined;
  }
  const { child, stdout, stderr, harnessRan } = spawnSandboxed(
    sandbox,
    'nix',
    ['print-dev-env', '--json', '--no-write-lock-file', `.#.devShells.${system}.default`],
    { workDir: root, env },
  );
  const printed = collect(stdout);
  const reason = tailOf(stderr);
  const closing = await new Promise<Error | number | null>((resolve) => {
    child.on('error', resolve);
    child.on('close', resolve);
  });
  if (!(await harnessRan)) {
    const why = closing instanceof Error ? closing.message : await reason;
    throw new Error(`the workload sandbox could not start: ${why}`);
  }
  if (closing !== 0) {
    const why = await reason;
    const how = closing === null ? 'on a signal' : `with code ${String(closing)}`;
    throw new DevShellFailed(
      why.length === 0
        ? `nix print-dev-env exited ${how}`
        : `nix print-dev-env exited ${how}: ${why}`,
    );
  }
  return exportedVariables(await printed);
};

export const underDevShell = (
  devShell: DevShell | undefined,
  env: Record<string, string>,
): Record<string, string> => {
  if (devShell === undefined) {
    return env;
  }
  const path = [devShell.PATH, env.PATH].filter(
    (entry) => entry !== undefined && entry !== '',
  );
  return { ...devShell, ...env, PATH: path.join(':') };
};
