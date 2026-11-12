import { errorMessage } from './errors.ts';
import { requireGithubRepository, type Fetch } from './frontier.ts';
import { GITHUB_REST_API } from './github-api.ts';

export interface BranchRulesTokens {
  read: () => Promise<string>;
  administration: () => Promise<string>;
}

interface PullRequestRule {
  type: string;
  ruleset_id?: unknown;
  parameters?: {
    required_approving_review_count?: unknown;
    require_last_push_approval?: unknown;
  };
}

interface Ruleset {
  id: number;
  name?: unknown;
  current_user_can_bypass?: unknown;
}

const NO_REVIEW = 'its default branch does not require an approving review';
const NO_LAST_PUSH_APPROVAL = 'its default branch does not require approval of the most recent push';
const ACTIONS_APPROVE = 'GitHub Actions can approve pull requests';

const get = async (fetch: Fetch, token: string, path: string): Promise<unknown> => {
  const response = await fetch(`${GITHUB_REST_API}${path}`, {
    headers: {
      authorization: `bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
  });
  const body = (await response.json().catch(() => ({}))) as { message?: unknown };
  if (!response.ok) {
    throw new Error(
      `GitHub answered ${response.status}${typeof body.message === 'string' ? `: ${body.message}` : ''}`,
    );
  }
  return body;
};

const bypassable = ({ name, current_user_can_bypass }: Ruleset): string | null =>
  current_user_can_bypass === 'never'
    ? null
    : `forge's App can bypass the ruleset "${typeof name === 'string' ? name : 'unnamed'}"`;

const readBranchRules = async (
  fetch: Fetch,
  token: string,
  github: string,
): Promise<string[]> => {
  const { default_branch } = (await get(fetch, token, `/repos/${github}`)) as {
    default_branch?: unknown;
  };
  if (typeof default_branch !== 'string' || default_branch === '') {
    throw new Error('GitHub returned no default branch');
  }
  const rules = (await get(
    fetch,
    token,
    `/repos/${github}/rules/branches/${encodeURIComponent(default_branch)}`,
  )) as PullRequestRule[];
  if (!Array.isArray(rules)) throw new Error('GitHub returned malformed rules');
  const failures: string[] = [];
  const pullRequests = rules.filter(({ type }) => type === 'pull_request');
  if (
    !pullRequests.some(({ parameters }) => {
      const count = parameters?.required_approving_review_count;
      return typeof count === 'number' && count >= 1;
    })
  ) {
    failures.push(NO_REVIEW);
  }
  if (!pullRequests.some(({ parameters }) => parameters?.require_last_push_approval === true)) {
    failures.push(NO_LAST_PUSH_APPROVAL);
  }
  const applying = new Set(rules.map(({ ruleset_id }) => ruleset_id));
  if (applying.size > 0) {
    const rulesets = (await get(
      fetch,
      token,
      `/repos/${github}/rulesets?includes_parents=true&per_page=100`,
    )) as Ruleset[];
    if (!Array.isArray(rulesets)) throw new Error('GitHub returned malformed rulesets');
    for (const ruleset of rulesets) {
      if (!applying.has(ruleset.id)) continue;
      const failure = bypassable(ruleset);
      if (failure !== null) failures.push(failure);
    }
  }
  return failures;
};

const readActionsApproval = async (
  fetch: Fetch,
  token: string,
  github: string,
): Promise<string[]> => {
  const permissions = (await get(
    fetch,
    token,
    `/repos/${github}/actions/permissions/workflow`,
  )) as { can_approve_pull_request_reviews?: unknown };
  return permissions.can_approve_pull_request_reviews === false ? [] : [ACTIONS_APPROVE];
};

export const checkBranchRules = async (
  fetch: Fetch,
  github: string,
  tokens: BranchRulesTokens,
): Promise<string[]> => {
  requireGithubRepository(github);
  const failures: string[] = [];
  try {
    failures.push(...(await readBranchRules(fetch, await tokens.read(), github)));
  } catch (error) {
    failures.push(`its default branch rules could not be read: ${errorMessage(error)}`);
  }
  try {
    failures.push(...(await readActionsApproval(fetch, await tokens.administration(), github)));
  } catch (error) {
    failures.push(
      `whether GitHub Actions can approve pull requests could not be read: ${errorMessage(error)}`,
    );
  }
  return failures;
};
