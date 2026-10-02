import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { SandboxUnavailable, spawnSandboxed, type Sandbox } from './sandbox.ts';

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

const PRINTED_EXCERPT_CHARS = 200;

const PRINT_DEV_ENV = 'nix print-dev-env';

const EXIT_PREFIX = new RegExp(`^${PRINT_DEV_ENV} exited [^:]*: `);

export class DevShellFailed extends Error {}

export const nixErrorOf = (error: string | null): string | null =>
  error
    ?.replace(EXIT_PREFIX, '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^error: \S/.test(line)) ?? error;

const collect = (stream: Readable): Promise<string> =>
  new Promise((resolve) => {
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      text += chunk;
    });
    stream.on('close', () => resolve(text));
  });

const variablesOf = (printed: string): Record<string, { type: string; value: unknown }> => {
  try {
    const { variables } = JSON.parse(printed) as { variables: unknown };
    if (typeof variables === 'object' && variables !== null) {
      return variables as Record<string, { type: string; value: unknown }>;
    }
  } catch {}
  throw new DevShellFailed(
    `${PRINT_DEV_ENV} printed no dev environment: ${printed.slice(0, PRINTED_EXCERPT_CHARS)}`,
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
  const { stdout, exited } = spawnSandboxed(
    sandbox,
    'nix',
    ['print-dev-env', '--json', '--no-write-lock-file', `.#.devShells.${system}.default`],
    { name: PRINT_DEV_ENV, workDir: root, env },
  );
  const printed = collect(stdout);
  const failure = await exited;
  if (failure instanceof SandboxUnavailable) {
    throw failure;
  }
  if (failure !== null) {
    throw new DevShellFailed(failure.message);
  }
  return exportedVariables(await printed);
};

export const underDevShell = (
  devShell: DevShell | undefined,
  system: Record<string, string>,
  deliberate: Record<string, string>,
): Record<string, string> => {
  if (devShell === undefined) {
    return { ...system, ...deliberate };
  }
  const path = [devShell.PATH, system.PATH].filter(
    (entry) => entry !== undefined && entry !== '',
  );
  return { ...system, ...devShell, ...deliberate, PATH: path.join(':') };
};
