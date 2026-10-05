import { FORGE_READY, type PullRequestRef, type PullRequestState } from './dispatch.ts';

export const GITHUB_GRAPHQL_API = 'https://api.github.com/graphql';

export const FRONTIER_PAGE_SIZE = 100;

const READY_FOR_AGENT = 'ready-for-agent';

export const FRONTIER_QUERY = `
  query Frontier($owner: String!, $name: String!, $first: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      issues(
        first: $first
        after: $after
        states: OPEN
        labels: ["${READY_FOR_AGENT}"]
        orderBy: { field: CREATED_AT, direction: ASC }
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          number
          title
          url
          createdAt
          labels(first: 100) {
            nodes {
              name
            }
          }
          issueDependenciesSummary {
            blockedBy
          }
          parent {
            number
            title
            url
          }
        }
      }
    }
  }
`;

const LABELLED_QUERY = `
  query LabelledIssues($owner: String!, $name: String!, $label: String!, $first: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      issues(
        first: $first
        after: $after
        states: OPEN
        labels: [$label]
        orderBy: { field: CREATED_AT, direction: ASC }
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          number
          url
        }
      }
    }
  }
`;

const TICKET_QUERY = `
  query Ticket($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        number
        title
        url
        state
        labels(first: 100) {
          nodes {
            name
          }
        }
        issueDependenciesSummary {
          blockedBy
        }
      }
    }
  }
`;

const CLOSING_PULL_REQUESTS_QUERY = `
  query ClosingPullRequests($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        closedByPullRequestsReferences(first: 100, includeClosedPrs: false) {
          nodes {
            number
            url
            state
            isCrossRepository
            repository {
              nameWithOwner
            }
          }
        }
      }
    }
  }
`;

const PULL_REQUEST_QUERY = `
  query PullRequest($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        state
        mergedAt
        closedAt
        commits(first: 100, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            commit {
              author {
                email
              }
            }
          }
        }
      }
    }
  }
`;

export type Fetch = typeof globalThis.fetch;

export interface SpecRef {
  number: number;
  title: string;
  url: string;
}

export interface Ticket {
  number: number;
  title: string;
  url: string;
  parent: SpecRef | null;
  createdAt: string;
  forgeReady: boolean;
  blocked: boolean;
}

export const oldestFirst = (a: Ticket, b: Ticket): number =>
  a.createdAt.localeCompare(b.createdAt) || a.number - b.number;

export interface PolledFrontier {
  repository: string;
  github: string;
  polledAt: string;
  tickets: Ticket[];
}

export interface PollFailure {
  message: string;
  failedAt: string;
}

export interface RepositoryFrontier extends Omit<PolledFrontier, 'polledAt'> {
  polledAt: string | null;
  lastError: PollFailure | null;
}

interface IssueNode {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  labels: { nodes: { name: string }[] };
  issueDependenciesSummary: { blockedBy: number };
  parent: SpecRef | null;
}

interface IssuePage<Node> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: Node[];
}

interface IssuesResponse<Node> {
  data?: { repository: { issues: IssuePage<Node> } | null };
  errors?: { message: string }[];
}

const GITHUB_REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export const isGithubRepository = (github: string): boolean =>
  GITHUB_REPOSITORY.test(github);

export const requireGithubRepository = (github: string): void => {
  if (!isGithubRepository(github)) {
    throw new Error(`'${github}' is not a GitHub owner/name`);
  }
};

export const isGithubUrl = (url: string): boolean =>
  url.startsWith('https://github.com/');

const ticketUrl = (url: string): string => {
  if (!isGithubUrl(url)) {
    throw new Error(`GitHub returned an unexpected issue URL '${url}'`);
  }
  return url;
};

const pullRequestUrl = (url: string): string => {
  if (!isGithubUrl(url)) {
    throw new Error(`GitHub returned an unexpected pull request URL '${url}'`);
  }
  return url;
};

const toTicket = (issue: IssueNode): Ticket => ({
  number: issue.number,
  title: issue.title,
  url: ticketUrl(issue.url),
  parent:
    issue.parent === null
      ? null
      : {
          number: issue.parent.number,
          title: issue.parent.title,
          url: issue.parent.url,
        },
  createdAt: issue.createdAt,
  forgeReady: issue.labels.nodes.some((label) => label.name === FORGE_READY),
  blocked: issue.issueDependenciesSummary.blockedBy > 0,
});

const requestGraphql = (
  fetch: Fetch,
  token: string,
  query: string,
  github: string,
  variables: Record<string, string | number | null>,
): Promise<Response> => {
  requireGithubRepository(github);
  const [owner, name] = github.split('/');
  return fetch(GITHUB_GRAPHQL_API, {
    method: 'POST',
    headers: {
      authorization: `bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      query,
      variables: { owner, name, ...variables },
    }),
  });
};

export const requestFrontierPage = (
  fetch: Fetch,
  token: string,
  github: string,
  { first, after }: { first: number; after: string | null },
): Promise<Response> =>
  requestGraphql(fetch, token, FRONTIER_QUERY, github, { first, after });

export const requestTicket = (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
): Promise<Response> =>
  requestGraphql(fetch, token, TICKET_QUERY, github, { number });

export const requestClosingPullRequests = (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
): Promise<Response> =>
  requestGraphql(fetch, token, CLOSING_PULL_REQUESTS_QUERY, github, { number });

const queryPage = async <Node>(
  subject: string,
  request: (after: string | null) => Promise<Response>,
  github: string,
  after: string | null,
): Promise<IssuePage<Node>> => {
  const response = await request(after);
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for ${github}`);
  }
  const { data, errors } = (await response.json()) as IssuesResponse<Node>;
  if (errors !== undefined && errors.length > 0) {
    throw new Error(
      `GitHub rejected the ${subject} query for ${github}: ${errors.map((error) => error.message).join('; ')}`,
    );
  }
  const repository = data?.repository;
  if (repository === undefined || repository === null) {
    throw new Error(`GitHub found no repository ${github}`);
  }
  return repository.issues;
};

const queryIssues = async <Node>(
  subject: string,
  github: string,
  request: (after: string | null) => Promise<Response>,
): Promise<Node[]> => {
  const issues: Node[] = [];
  const cursors = new Set<string>();
  let after: string | null = null;
  do {
    const page: IssuePage<Node> = await queryPage<Node>(subject, request, github, after);
    issues.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    if (after !== null && cursors.has(after)) {
      throw new Error(`GitHub paging did not advance for ${github}`);
    }
    if (after !== null) cursors.add(after);
  } while (after !== null);
  return issues;
};

export const queryFrontier = async (
  fetch: Fetch,
  token: string,
  github: string,
): Promise<Ticket[]> =>
  (
    await queryIssues<IssueNode>('frontier', github, (after) =>
      requestFrontierPage(fetch, token, github, {
        first: FRONTIER_PAGE_SIZE,
        after,
      }),
    )
  )
    .map(toTicket)
    .filter((ticket) => !ticket.blocked || ticket.forgeReady);

export interface LabelledIssue {
  number: number;
  url: string;
}

export const requestLabelledPage = (
  fetch: Fetch,
  token: string,
  github: string,
  label: string,
  { first, after }: { first: number; after: string | null },
): Promise<Response> =>
  requestGraphql(fetch, token, LABELLED_QUERY, github, { label, first, after });

export const queryLabelled = async (
  fetch: Fetch,
  token: string,
  github: string,
  label: string,
): Promise<LabelledIssue[]> =>
  (
    await queryIssues<LabelledIssue>(`${label} issues`, github, (after) =>
      requestLabelledPage(fetch, token, github, label, {
        first: FRONTIER_PAGE_SIZE,
        after,
      }),
    )
  ).map((issue) => ({ number: issue.number, url: ticketUrl(issue.url) }));

export interface TicketState {
  number: number;
  title: string;
  url: string;
  open: boolean;
  labels: string[];
  blockedBy: number;
}

interface TicketNode {
  number: number;
  title: string;
  url: string;
  state: string;
  labels: { nodes: { name: string }[] };
  issueDependenciesSummary: { blockedBy: number };
}

interface TicketResponse {
  data?: { repository: { issue: TicketNode | null } | null };
  errors?: { message: string }[];
}

export const queryTicket = async (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
): Promise<TicketState> => {
  const response = await requestTicket(fetch, token, github, number);
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for ${github}#${number}`);
  }
  const { data, errors } = (await response.json()) as TicketResponse;
  const issue = data?.repository?.issue;
  if (issue === undefined || issue === null) {
    const reason =
      errors === undefined || errors.length === 0
        ? 'no such issue'
        : errors.map((error) => error.message).join('; ');
    throw new Error(`GitHub found no ticket ${github}#${number}: ${reason}`);
  }
  return {
    number: issue.number,
    title: issue.title,
    url: ticketUrl(issue.url),
    open: issue.state === 'OPEN',
    labels: issue.labels.nodes.map((label) => label.name),
    blockedBy: issue.issueDependenciesSummary.blockedBy,
  };
};

interface ClosingPullRequestsResponse {
  data?: {
    repository: {
      issue: {
        closedByPullRequestsReferences: {
          nodes: {
            number: number;
            url: string;
            state: string;
            isCrossRepository: boolean;
            repository: { nameWithOwner: string };
          }[];
        };
      } | null;
    } | null;
  };
  errors?: { message: string }[];
}

export const findOpenClosingPullRequest = async (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
): Promise<PullRequestRef | null> => {
  const response = await requestClosingPullRequests(fetch, token, github, number);
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for ${github}#${number}`);
  }
  const { data, errors } = (await response.json()) as ClosingPullRequestsResponse;
  const issue = data?.repository?.issue;
  if (issue === undefined || issue === null) {
    const reason =
      errors === undefined || errors.length === 0
        ? 'no such issue'
        : errors.map((error) => error.message).join('; ');
    throw new Error(
      `GitHub found no pull requests closing ${github}#${number}: ${reason}`,
    );
  }
  const pullRequest = issue.closedByPullRequestsReferences.nodes.find(
    (node) =>
      node.state === 'OPEN' &&
      !node.isCrossRepository &&
      node.repository.nameWithOwner.toLowerCase() === github.toLowerCase(),
  );
  return pullRequest === undefined
    ? null
    : { number: pullRequest.number, url: pullRequestUrl(pullRequest.url) };
};

export interface PullRequestSnapshot {
  state: PullRequestState;
  settledAt: string | null;
  commitAuthors: (string | null)[];
}

interface PullRequestNode {
  state: string;
  mergedAt: string | null;
  closedAt: string | null;
  commits: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: { commit: { author: { email: string | null } | null } }[];
  };
}

interface PullRequestResponse {
  data?: { repository: { pullRequest: PullRequestNode | null } | null };
  errors?: { message: string }[];
}

export const requestPullRequest = (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
  after: string | null,
): Promise<Response> =>
  requestGraphql(fetch, token, PULL_REQUEST_QUERY, github, { number, after });

const queryPullRequestPage = async (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
  after: string | null,
): Promise<PullRequestNode> => {
  const response = await requestPullRequest(fetch, token, github, number, after);
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for ${github}#${number}`);
  }
  const { data, errors } = (await response.json()) as PullRequestResponse;
  const pullRequest = data?.repository?.pullRequest;
  if (pullRequest === undefined || pullRequest === null) {
    const reason =
      errors === undefined || errors.length === 0
        ? 'no such pull request'
        : errors.map((error) => error.message).join('; ');
    throw new Error(`GitHub found no pull request ${github}#${number}: ${reason}`);
  }
  return pullRequest;
};

const PULL_REQUEST_STATES: Record<string, PullRequestState> = {
  OPEN: 'open',
  MERGED: 'merged',
  CLOSED: 'closed',
};

export const queryPullRequest = async (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
): Promise<PullRequestSnapshot> => {
  const commitAuthors: (string | null)[] = [];
  const cursors = new Set<string>();
  let after: string | null = null;
  let first: PullRequestNode | null = null;
  do {
    const page: PullRequestNode = await queryPullRequestPage(fetch, token, github, number, after);
    first ??= page;
    commitAuthors.push(...page.commits.nodes.map(({ commit }) => commit.author?.email ?? null));
    after = page.commits.pageInfo.hasNextPage ? page.commits.pageInfo.endCursor : null;
    if (after !== null && cursors.has(after)) {
      throw new Error(`GitHub paging did not advance for ${github}#${number}`);
    }
    if (after !== null) cursors.add(after);
  } while (after !== null);
  const state = Object.hasOwn(PULL_REQUEST_STATES, first.state)
    ? PULL_REQUEST_STATES[first.state]
    : undefined;
  if (state === undefined) {
    throw new Error(`GitHub reported ${github}#${number} in an unknown state '${first.state}'`);
  }
  return {
    state,
    settledAt: state === 'merged' ? first.mergedAt : state === 'closed' ? first.closedAt : null,
    commitAuthors,
  };
};

export const reworkOf = (commitAuthors: (string | null)[], forgeEmail: string): number =>
  commitAuthors.filter((email) => email?.toLowerCase() !== forgeEmail.toLowerCase()).length;

export const offFrontier = (ticket: TicketState): string | null => {
  if (!ticket.open) return 'it is closed';
  if (!ticket.labels.includes(READY_FOR_AGENT)) {
    return `it is not labelled ${READY_FOR_AGENT}`;
  }
  if (ticket.blockedBy > 0) return 'it has open blockers';
  return null;
};
