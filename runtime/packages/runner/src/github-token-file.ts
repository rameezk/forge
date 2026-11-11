import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage, type InstallationToken } from '@forge/shared';

export const GITHUB_TOKEN_FILE_ENV = 'FORGE_GITHUB_TOKEN_FILE';

const TOKEN_FILE = 'github-token';

export class GithubTokenFile {
  readonly #dir: string;
  readonly #redactions: string[];

  private constructor(dir: string, redactions: string[]) {
    this.#dir = dir;
    this.#redactions = redactions;
  }

  static create(
    root: string,
    runId: string,
    token: string,
    redactions: string[],
  ): GithubTokenFile {
    const dir = join(root, runId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const file = new GithubTokenFile(dir, redactions);
    try {
      file.replace(token);
    } catch (error) {
      file.remove();
      throw error;
    }
    return file;
  }

  get path(): string {
    return join(this.#dir, TOKEN_FILE);
  }

  get environment(): Record<string, string> {
    return { [GITHUB_TOKEN_FILE_ENV]: this.path };
  }

  replace(token: string): void {
    this.#redactions.push(token);
    const staged = join(this.#dir, `${TOKEN_FILE}.next`);
    writeFileSync(staged, token, { mode: 0o600 });
    renameSync(staged, this.path);
  }

  remove(): void {
    rmSync(this.#dir, { recursive: true, force: true });
  }
}

const MIN_REFRESH_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 60_000;

export const revokingQuietly =
  (revoke: (token: string) => Promise<void>, what: string): ((token: string) => Promise<void>) =>
  async (token) => {
    try {
      await revoke(token);
    } catch (error) {
      console.error(`could not revoke the ${what}'s GitHub token: ${errorMessage(error)}`);
    }
  };

export const keepFresh = (
  file: GithubTokenFile,
  first: InstallationToken,
  mint: () => Promise<InstallationToken>,
  missed: (error: unknown) => void,
  revoke: (token: string) => Promise<void>,
  now: () => number = Date.now,
): (() => Promise<void>) => {
  let stopped = false;
  let held = first.token;
  let refreshing: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  const refresh = async (expiresAt: string, failures: number): Promise<void> => {
    let next: InstallationToken;
    try {
      next = await mint();
    } catch (error) {
      if (stopped) return;
      missed(error);
      schedule(expiresAt, failures + 1);
      return;
    }
    if (stopped) {
      await revoke(next.token);
      return;
    }
    try {
      file.replace(next.token);
    } catch (error) {
      await revoke(next.token);
      missed(error);
      schedule(expiresAt, failures + 1);
      return;
    }
    const replaced = held;
    held = next.token;
    schedule(next.expiresAt, 0);
    await revoke(replaced);
  };
  const schedule = (expiresAt: string, failures: number): void => {
    const delay =
      failures === 0
        ? Math.max(MIN_REFRESH_DELAY_MS, (Date.parse(expiresAt) - now()) / 2)
        : Math.min(MAX_RETRY_DELAY_MS, MIN_REFRESH_DELAY_MS * 2 ** (failures - 1));
    timer = setTimeout(() => {
      refreshing = refresh(expiresAt, failures);
    }, delay);
  };
  schedule(first.expiresAt, 0);
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await refreshing;
    const last = held;
    held = '';
    if (last !== '') await revoke(last);
  };
};
