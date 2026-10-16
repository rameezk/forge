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

export const LABELLED_QUERY = `
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

export const TICKET_QUERY = `
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

export const CLOSING_PULL_REQUESTS_QUERY = `
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

export const PULL_REQUEST_QUERY = `
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

export const PULL_REQUEST_HEAD_QUERY = `
  query PullRequestHead($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        number
        url
        state
        isCrossRepository
        headRefName
        closingIssuesReferences(first: 20) {
          nodes {
            number
            repository {
              nameWithOwner
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

export const pullRequestUrl = (url: string): string => {
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

export const requestGraphql = (
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

const QUERY_NAME = /\bquery\s+(\w+)/;

export const readGraphql = async <Data>(
  response: Response,
  query: string,
  where: string,
): Promise<Data | undefined> => {
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for ${where}`);
  }
  const { data, errors } = (await response.json()) as {
    data?: Data;
    errors?: { message: string }[];
  };
  if (errors !== undefined && errors.length > 0) {
    throw new Error(
      `GitHub rejected the ${QUERY_NAME.exec(query)?.[1] ?? 'GraphQL'} query for ${where}: ${errors.map((error) => error.message).join('; ')}`,
    );
  }
  return data;
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
  query: string,
  request: (after: string | null) => Promise<Response>,
  github: string,
  after: string | null,
): Promise<IssuePage<Node>> => {
  const data = await readGraphql<{ repository: { issues: IssuePage<Node> } | null }>(
    await request(after),
    query,
    github,
  );
  const repository = data?.repository;
  if (repository === undefined || repository === null) {
    throw new Error(`GitHub found no repository ${github}`);
  }
  return repository.issues;
};

const queryIssues = async <Node>(
  query: string,
  github: string,
  request: (after: string | null) => Promise<Response>,
): Promise<Node[]> => {
  const issues: Node[] = [];
  const cursors = new Set<string>();
  let after: string | null = null;
  do {
    const page: IssuePage<Node> = await queryPage<Node>(query, request, github, after);
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
    await queryIssues<IssueNode>(FRONTIER_QUERY, github, (after) =>
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
    await queryIssues<LabelledIssue>(LABELLED_QUERY, github, (after) =>
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
  repository: { issue: TicketNode | null } | null;
}

export const queryTicket = async (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
): Promise<TicketState> => {
  const data = await readGraphql<TicketResponse>(
    await requestTicket(fetch, token, github, number),
    TICKET_QUERY,
    `${github}#${number}`,
  );
  const issue = data?.repository?.issue;
  if (issue === undefined || issue === null) {
    throw new Error(`GitHub found no ticket ${github}#${number}`);
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
}

export const findOpenClosingPullRequest = async (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
): Promise<PullRequestRef | null> => {
  const data = await readGraphql<ClosingPullRequestsResponse>(
    await requestClosingPullRequests(fetch, token, github, number),
    CLOSING_PULL_REQUESTS_QUERY,
    `${github}#${number}`,
  );
  const issue = data?.repository?.issue;
  if (issue === undefined || issue === null) {
    throw new Error(`GitHub found no pull requests closing ${github}#${number}`);
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
  repository: { pullRequest: PullRequestNode | null } | null;
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
  const data = await readGraphql<PullRequestResponse>(
    await requestPullRequest(fetch, token, github, number, after),
    PULL_REQUEST_QUERY,
    `${github}#${number}`,
  );
  const pullRequest = data?.repository?.pullRequest;
  if (pullRequest === undefined || pullRequest === null) {
    throw new Error(`GitHub found no pull request ${github}#${number}`);
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

export interface PullRequestHead extends PullRequestRef {
  open: boolean;
  fromFork: boolean;
  branch: string;
  closes: number[];
}

interface PullRequestHeadResponse {
  repository: {
    pullRequest: {
      number: number;
      url: string;
      state: string;
      isCrossRepository: boolean;
      headRefName: string;
      closingIssuesReferences: {
        nodes: { number: number; repository: { nameWithOwner: string } }[];
      };
    } | null;
  } | null;
}

export const queryPullRequestHead = async (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
): Promise<PullRequestHead> => {
  const data = await readGraphql<PullRequestHeadResponse>(
    await requestGraphql(fetch, token, PULL_REQUEST_HEAD_QUERY, github, { number }),
    PULL_REQUEST_HEAD_QUERY,
    `${github}#${number}`,
  );
  const pullRequest = data?.repository?.pullRequest;
  if (pullRequest === undefined || pullRequest === null) {
    throw new Error(`GitHub found no pull request ${github}#${number}`);
  }
  return {
    number: pullRequest.number,
    url: pullRequestUrl(pullRequest.url),
    open: pullRequest.state === 'OPEN',
    fromFork: pullRequest.isCrossRepository,
    branch: pullRequest.headRefName,
    closes: pullRequest.closingIssuesReferences.nodes
      .filter((issue) => issue.repository.nameWithOwner.toLowerCase() === github.toLowerCase())
      .map((issue) => issue.number),
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
