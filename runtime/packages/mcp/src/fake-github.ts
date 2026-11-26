import type { GitHub, IssueState } from './github.ts';

export interface FakeIssue extends Partial<IssueState> {
  github: string;
  number: number;
}

export type GitHubWrite =
  | { kind: 'label'; github: string; number: number; label: string }
  | { kind: 'assign'; github: string; number: number; login: string }
  | { kind: 'unassign'; github: string; number: number; login: string };

export interface FakeGitHubState {
  operator?: string;
  issues?: FakeIssue[];
}

export class FakeGitHub implements GitHub {
  readonly writes: GitHubWrite[] = [];
  readonly #operator: string;
  readonly #issues: FakeIssue[];

  constructor({ operator = 'operator', issues = [] }: FakeGitHubState = {}) {
    this.#operator = operator;
    this.#issues = issues;
  }

  async operator(): Promise<string> {
    return this.#operator;
  }

  async issue(github: string, number: number): Promise<IssueState> {
    const issue = this.#issues.find((candidate) => candidate.github === github && candidate.number === number);
    if (issue === undefined) throw new Error(`GitHub found no ticket ${github}#${number}`);
    return {
      url: `https://github.com/${github}/issues/${number}`,
      open: true,
      labels: [],
      assignees: [],
      blockedBy: [],
      ...issue,
    };
  }

  async applyForgeReady(github: string, number: number): Promise<void> {
    this.writes.push({ kind: 'label', github, number, label: 'forge:ready' });
  }

  async assign(github: string, number: number, login: string): Promise<void> {
    this.writes.push({ kind: 'assign', github, number, login });
  }

  async unassign(github: string, number: number, login: string): Promise<void> {
    this.writes.push({ kind: 'unassign', github, number, login });
  }
}
