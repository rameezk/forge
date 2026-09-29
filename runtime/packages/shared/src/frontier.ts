export const GITHUB_GRAPHQL_API = 'https://api.github.com/graphql';

export const FRONTIER_PAGE_SIZE = 100;

export const FRONTIER_QUERY = `
  query Frontier($owner: String!, $name: String!, $first: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      issues(
        first: $first
        after: $after
        states: OPEN
        labels: ["ready-for-agent"]
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
          issueDependenciesSummary {
            blockedBy
          }
          parent {
            number
            title
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
}

export interface Ticket {
  number: number;
  title: string;
  url: string;
  parent: SpecRef | null;
  createdAt: string;
}

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
  issueDependenciesSummary: { blockedBy: number };
  parent: SpecRef | null;
}

interface IssuePage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: IssueNode[];
}

interface FrontierResponse {
  data?: { repository: { issues: IssuePage } | null };
  errors?: { message: string }[];
}

const GITHUB_REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export const isGithubRepository = (github: string): boolean =>
  GITHUB_REPOSITORY.test(github);

export const isGithubUrl = (url: string): boolean =>
  url.startsWith('https://github.com/');

const ticketUrl = (url: string): string => {
  if (!isGithubUrl(url)) {
    throw new Error(`GitHub returned an unexpected issue URL '${url}'`);
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
      : { number: issue.parent.number, title: issue.parent.title },
  createdAt: issue.createdAt,
});

export const requestFrontierPage = (
  fetch: Fetch,
  token: string,
  github: string,
  { first, after }: { first: number; after: string | null },
): Promise<Response> => {
  const [owner, name] = github.split('/');
  return fetch(GITHUB_GRAPHQL_API, {
    method: 'POST',
    headers: {
      authorization: `bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      query: FRONTIER_QUERY,
      variables: { owner, name, first, after },
    }),
  });
};

const queryPage = async (
  fetch: Fetch,
  token: string,
  github: string,
  after: string | null,
): Promise<IssuePage> => {
  const response = await requestFrontierPage(fetch, token, github, {
    first: FRONTIER_PAGE_SIZE,
    after,
  });
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for ${github}`);
  }
  const { data, errors } = (await response.json()) as FrontierResponse;
  if (errors !== undefined && errors.length > 0) {
    throw new Error(
      `GitHub rejected the frontier query for ${github}: ${errors.map((error) => error.message).join('; ')}`,
    );
  }
  const repository = data?.repository;
  if (repository === undefined || repository === null) {
    throw new Error(`GitHub found no repository ${github}`);
  }
  return repository.issues;
};

export const queryFrontier = async (
  fetch: Fetch,
  token: string,
  github: string,
): Promise<Ticket[]> => {
  if (!isGithubRepository(github)) {
    throw new Error(`'${github}' is not a GitHub owner/name`);
  }
  const issues: IssueNode[] = [];
  const cursors = new Set<string>();
  let after: string | null = null;
  do {
    const page = await queryPage(fetch, token, github, after);
    issues.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    if (after !== null && cursors.has(after)) {
      throw new Error(`GitHub paging did not advance for ${github}`);
    }
    if (after !== null) cursors.add(after);
  } while (after !== null);
  return issues
    .filter((issue) => issue.issueDependenciesSummary.blockedBy === 0)
    .map(toTicket);
};
