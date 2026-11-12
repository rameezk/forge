export interface Answer {
  status: number;
  body: unknown;
}

export interface Ruleset {
  id: number;
  name: string;
  bypass: 'never' | 'always' | 'pull_requests_only' | 'exempt';
  pullRequest?: { approvals: number; lastPushApproval: boolean };
}

export interface RepositoryRules {
  rulesets: Ruleset[];
  rules?: Answer;
  actions: Answer;
}

const ok = (body: unknown): Answer => ({ status: 200, body });

export const PROTECTED: RepositoryRules = {
  rulesets: [
    {
      id: 1,
      name: 'protect main',
      bypass: 'never',
      pullRequest: { approvals: 1, lastPushApproval: true },
    },
  ],
  actions: ok({ default_workflow_permissions: 'read', can_approve_pull_request_reviews: false }),
};

export const withPullRequest = (
  pullRequest: { approvals: number; lastPushApproval: boolean },
): RepositoryRules => ({
  ...PROTECTED,
  rulesets: [{ id: 1, name: 'protect main', bypass: 'never', pullRequest }],
});

export const bypassable = (bypass: Ruleset['bypass']): RepositoryRules => ({
  ...PROTECTED,
  rulesets: [
    {
      id: 7,
      name: 'protect main',
      bypass,
      pullRequest: { approvals: 1, lastPushApproval: true },
    },
  ],
});

export const actionsApproving: RepositoryRules = {
  ...PROTECTED,
  actions: ok({ default_workflow_permissions: 'read', can_approve_pull_request_reviews: true }),
};

export const unreadable: RepositoryRules = {
  rulesets: [],
  rules: {
    status: 403,
    body: { message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.' },
  },
  actions: ok({ default_workflow_permissions: 'read', can_approve_pull_request_reviews: false }),
};

const rulesOf = ({ rulesets }: RepositoryRules): unknown[] =>
  rulesets.flatMap(({ id, name, pullRequest }) => [
    {
      type: 'pull_request',
      ruleset_source_type: 'Repository',
      ruleset_source: name,
      ruleset_id: id,
      ...(pullRequest === undefined
        ? {}
        : {
            parameters: {
              required_approving_review_count: pullRequest.approvals,
              require_last_push_approval: pullRequest.lastPushApproval,
            },
          }),
    },
  ]);

export const answerRules = (
  pathname: string,
  repositories: Record<string, RepositoryRules>,
): Answer | null => {
  const match =
    /^\/repos\/([^/]+\/[^/]+)(?:\/(rules\/branches\/main|rulesets|actions\/permissions\/workflow))?$/.exec(pathname);
  if (match === null) return null;
  const repository = repositories[match[1] ?? ''] ?? PROTECTED;
  switch (match[2]) {
    case undefined:
      return ok({ default_branch: 'main' });
    case 'rules/branches/main':
      return repository.rules ?? ok(rulesOf(repository));
    case 'rulesets':
      return ok(
        repository.rulesets.map(({ id, name, bypass }) => ({
          id,
          name,
          current_user_can_bypass: bypass,
        })),
      );
    default:
      return repository.actions;
  }
};

export const withProtectedRepositories =
  (
    other: typeof globalThis.fetch,
    repositories: Record<string, RepositoryRules> = {},
  ): typeof globalThis.fetch =>
  async (input, init) => {
    const answer = answerRules(new URL(String(input)).pathname, repositories);
    return answer === null
      ? other(input, init)
      : new Response(JSON.stringify(answer.body), {
          status: answer.status,
          headers: { 'content-type': 'application/json' },
        });
  };
