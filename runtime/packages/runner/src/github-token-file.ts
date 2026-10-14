import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InstallationToken } from '@forge/shared';

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

export const keepFresh = (
  file: GithubTokenFile,
  first: InstallationToken,
  mint: () => Promise<InstallationToken>,
  missed: (error: unknown) => void,
  now: () => number = Date.now,
): (() => void) => {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const schedule = (expiresAt: string): void => {
    const remaining = Date.parse(expiresAt) - now();
    const delay = Math.max(MIN_REFRESH_DELAY_MS, remaining / 2);
    timer = setTimeout(() => {
      mint().then(
        (next) => {
          if (stopped) return;
          file.replace(next.token);
          schedule(next.expiresAt);
        },
        (error: unknown) => {
          if (stopped) return;
          missed(error);
          schedule(expiresAt);
        },
      );
    }, delay);
  };
  schedule(first.expiresAt);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
};
