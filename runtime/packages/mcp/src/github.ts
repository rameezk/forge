import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  applyForgeReady,
  assign,
  queryOperatorTicket,
  queryViewerLogin,
  unassign,
  type Fetch,
  type OperatorTicket,
} from '@forge/shared';

export type IssueState = OperatorTicket;

export interface GitHub {
  operator(): Promise<string>;
  issue(github: string, number: number): Promise<IssueState>;
  applyForgeReady(github: string, number: number): Promise<void>;
  assign(github: string, number: number, login: string): Promise<void>;
  unassign(github: string, number: number, login: string): Promise<void>;
}

const run = promisify(execFile);

export const ghToken = async (): Promise<string> => {
  try {
    const { stdout } = await run('gh', ['auth', 'token'], { timeout: 15_000 });
    const token = stdout.trim();
    if (token !== '') return token;
  } catch (error) {
    throw new Error(`could not read the GitHub login from gh: ${error instanceof Error ? error.message : String(error)}. Run gh auth login first`);
  }
  throw new Error('gh holds no GitHub login. Run gh auth login first');
};

export class OperatorGitHub implements GitHub {
  readonly #token: () => Promise<string>;
  readonly #fetch: Fetch;

  constructor(token: () => Promise<string> = ghToken, fetch: Fetch = globalThis.fetch) {
    this.#token = token;
    this.#fetch = fetch;
  }

  async operator(): Promise<string> {
    return queryViewerLogin(this.#fetch, await this.#token());
  }

  async issue(github: string, number: number): Promise<IssueState> {
    return queryOperatorTicket(this.#fetch, await this.#token(), github, number);
  }

  async applyForgeReady(github: string, number: number): Promise<void> {
    return applyForgeReady(this.#fetch, await this.#token(), github, number);
  }

  async assign(github: string, number: number, login: string): Promise<void> {
    return assign(this.#fetch, await this.#token(), github, number, login);
  }

  async unassign(github: string, number: number, login: string): Promise<void> {
    return unassign(this.#fetch, await this.#token(), github, number, login);
  }
}
