import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { errorMessage } from '@forge/shared';

export const NON_JSON_EXCERPT_CHARS = 200;

const VERSION_TIMEOUT_MS = 10_000;

export const nonEmpty = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

export const realCommand = (command: string): string => {
  const unresolved = (reason: string): Error =>
    new Error(`the harness command ${command} cannot be resolved: ${reason}`);
  if (!isAbsolute(command)) {
    throw unresolved('it is not an absolute path');
  }
  try {
    return realpathSync(command);
  } catch (cause) {
    throw unresolved(errorMessage(cause));
  }
};

const commandOutput = (
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(command, args, { env, timeout: VERSION_TIMEOUT_MS }, (error, stdout) =>
      error === null ? resolve(stdout.trim()) : reject(error),
    );
  });

export const versionOutput = async (
  command: string,
  env: Record<string, string>,
): Promise<string> =>
  commandOutput(realCommand(command), ['--version'], env).catch((cause: unknown) => {
    process.stderr.write(
      `could not read the harness version (${errorMessage(cause)}), so the workload's fingerprint records none\n`,
    );
    return '';
  });
