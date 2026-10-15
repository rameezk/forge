import { pullRequestUrl, requestGraphql, type Fetch } from './frontier.ts';

export const WATCHED_PAGE_SIZE = 50;

const WATCHED_PULL_REQUESTS_QUERY = `
  query WatchedPullRequests($owner: String!, $name: String!, $first: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(
        first: $first
        after: $after
        states: OPEN
        orderBy: { field: CREATED_AT, direction: ASC }
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          number
          url
          author {
            __typename
            login
          }
          closingIssuesReferences(first: 10) {
            nodes {
              number
              repository {
                nameWithOwner
              }
            }
          }
          reviews(last: 100) {
            nodes {
              author {
                __typename
                login
              }
              authorAssociation
              body
              submittedAt
              comments {
                totalCount
              }
            }
          }
          comments(last: 100) {
            nodes {
              author {
                __typename
                login
              }
              authorAssociation
              createdAt
            }
          }
        }
      }
    }
  }
`;

interface Actor {
  __typename: string;
  login: string;
}

interface WatchedNode {
  number: number;
  url: string;
  author: Actor | null;
  closingIssuesReferences: {
    nodes: { number: number; repository: { nameWithOwner: string } }[];
  };
  reviews: {
    nodes: {
      author: Actor | null;
      authorAssociation: string;
      body: string;
      submittedAt: string | null;
      comments: { totalCount: number };
    }[];
  };
  comments: { nodes: { author: Actor | null; authorAssociation: string; createdAt: string }[] };
}

interface WatchedPage {
  pullRequests: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: WatchedNode[];
  };
}

interface WatchedResponse {
  data?: { repository: WatchedPage | null };
  errors?: { message: string }[];
}

export interface WatchedPullRequest {
  number: number;
  url: string;
  closes: number[];
  newestFeedbackAt: string | null;
}

const FEEDBACK_ASSOCIATIONS = new Set(['OWNER', 'COLLABORATOR']);

export const givesFeedback = (author: Actor | null, authorAssociation: string): boolean =>
  (author === null || author.__typename !== 'Bot') && FEEDBACK_ASSOCIATIONS.has(authorAssociation);

const newest = (times: string[]): string | null =>
  times.reduce<string | null>((latest, time) => (latest === null || time > latest ? time : latest), null);

const newestFeedback = (node: WatchedNode): string | null =>
  newest([
    ...node.reviews.nodes.flatMap((review) =>
      review.submittedAt !== null &&
      givesFeedback(review.author, review.authorAssociation) &&
      (review.body.trim() !== '' || review.comments.totalCount > 0)
        ? [review.submittedAt]
        : [],
    ),
    ...node.comments.nodes.flatMap((comment) =>
      givesFeedback(comment.author, comment.authorAssociation) ? [comment.createdAt] : [],
    ),
  ]);

const toWatched = (node: WatchedNode, github: string): WatchedPullRequest => ({
  number: node.number,
  url: pullRequestUrl(node.url),
  closes: node.closingIssuesReferences.nodes
    .filter((issue) => issue.repository.nameWithOwner.toLowerCase() === github.toLowerCase())
    .map((issue) => issue.number),
  newestFeedbackAt: newestFeedback(node),
});

const queryWatchedPage = async (
  fetch: Fetch,
  token: string,
  github: string,
  after: string | null,
): Promise<WatchedPage> => {
  const response = await requestGraphql(fetch, token, WATCHED_PULL_REQUESTS_QUERY, github, {
    first: WATCHED_PAGE_SIZE,
    after,
  });
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for ${github}`);
  }
  const { data, errors } = (await response.json()) as WatchedResponse;
  if (errors !== undefined && errors.length > 0) {
    throw new Error(
      `GitHub rejected the pull request query for ${github}: ${errors.map((error) => error.message).join('; ')}`,
    );
  }
  const repository = data?.repository;
  if (repository === undefined || repository === null) {
    throw new Error(`GitHub found no repository ${github}`);
  }
  return repository;
};

export const queryWatchedPullRequests = async (
  fetch: Fetch,
  token: string,
  github: string,
  appLogin: string,
): Promise<WatchedPullRequest[]> => {
  const watched: WatchedPullRequest[] = [];
  const cursors = new Set<string>();
  let after: string | null = null;
  do {
    const { pullRequests } = await queryWatchedPage(fetch, token, github, after);
    watched.push(
      ...pullRequests.nodes
        .filter(
          ({ author }) =>
            author?.__typename === 'Bot' && author.login.toLowerCase() === appLogin.toLowerCase(),
        )
        .map((node) => toWatched(node, github)),
    );
    after = pullRequests.pageInfo.hasNextPage ? pullRequests.pageInfo.endCursor : null;
    if (after !== null && cursors.has(after)) {
      throw new Error(`GitHub paging did not advance for ${github}`);
    }
    if (after !== null) cursors.add(after);
  } while (after !== null);
  return watched;
};

const FEEDBACK_WINDOW_QUERY = `
  query FeedbackWindow($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviews(last: 100) {
          nodes {
            url
            author {
              __typename
              login
            }
            authorAssociation
            body
            submittedAt
            comments(first: 100) {
              nodes {
                url
                author {
                  __typename
                  login
                }
                authorAssociation
                body
                createdAt
                path
                line
                originalLine
              }
            }
          }
        }
        comments(last: 100) {
          nodes {
            url
            author {
              __typename
              login
            }
            authorAssociation
            body
            createdAt
          }
        }
      }
    }
  }
`;

interface AuthoredNode {
  url: string;
  author: Actor | null;
  authorAssociation: string;
  body: string;
}

interface FeedbackWindowResponse {
  data?: {
    repository: {
      pullRequest: {
        reviews: {
          nodes: (AuthoredNode & {
            submittedAt: string | null;
            comments: {
              nodes: (AuthoredNode & {
                createdAt: string;
                path: string;
                line: number | null;
                originalLine: number | null;
              })[];
            };
          })[];
        };
        comments: { nodes: (AuthoredNode & { createdAt: string })[] };
      } | null;
    } | null;
  };
  errors?: { message: string }[];
}

export type FeedbackKind = 'review summary' | 'inline review comment' | 'conversation comment';

export interface FeedbackItem {
  kind: FeedbackKind;
  author: string;
  url: string;
  body: string;
  createdAt: string;
  path: string | null;
  line: number | null;
}

const authorOf = (author: Actor | null): string => author?.login ?? 'ghost';

export const queryFeedbackWindow = async (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
  after: string | null,
  until: string,
): Promise<FeedbackItem[]> => {
  const response = await requestGraphql(fetch, token, FEEDBACK_WINDOW_QUERY, github, { number });
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for ${github}#${number}`);
  }
  const { data, errors } = (await response.json()) as FeedbackWindowResponse;
  const pullRequest = data?.repository?.pullRequest;
  if (pullRequest === undefined || pullRequest === null) {
    const reason =
      errors === undefined || errors.length === 0
        ? 'no such pull request'
        : errors.map((error) => error.message).join('; ');
    throw new Error(`GitHub found no pull request ${github}#${number}: ${reason}`);
  }
  const instant = (time: string): number => Date.parse(time);
  const inWindow = (time: string): boolean =>
    (after === null || instant(time) > instant(after)) && instant(time) <= instant(until);
  const counts = (node: AuthoredNode & { at: string | null }): boolean =>
    node.at !== null && inWindow(node.at) && givesFeedback(node.author, node.authorAssociation);
  const items: FeedbackItem[] = [
    ...pullRequest.reviews.nodes.flatMap((review): FeedbackItem[] => [
      ...(review.body.trim() !== '' && counts({ ...review, at: review.submittedAt })
        ? [
            {
              kind: 'review summary' as const,
              author: authorOf(review.author),
              url: review.url,
              body: review.body,
              createdAt: review.submittedAt as string,
              path: null,
              line: null,
            },
          ]
        : []),
      ...review.comments.nodes
        .filter((comment) => counts({ ...comment, at: comment.createdAt }))
        .map((comment) => ({
          kind: 'inline review comment' as const,
          author: authorOf(comment.author),
          url: comment.url,
          body: comment.body,
          createdAt: comment.createdAt,
          path: comment.path,
          line: comment.line ?? comment.originalLine,
        })),
    ]),
    ...pullRequest.comments.nodes
      .filter((comment) => counts({ ...comment, at: comment.createdAt }))
      .map((comment) => ({
        kind: 'conversation comment' as const,
        author: authorOf(comment.author),
        url: comment.url,
        body: comment.body,
        createdAt: comment.createdAt,
        path: null,
        line: null,
      })),
  ];
  return items.sort((a, b) => instant(a.createdAt) - instant(b.createdAt));
};

const FEEDBACK_ANSWERS_QUERY = `
  query FeedbackAnswers($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviews(last: 100) {
          nodes {
            url
            reactions(content: THUMBS_UP, first: 100) {
              nodes {
                createdAt
                reactor {
                  __typename
                  ... on Actor {
                    login
                  }
                }
              }
            }
          }
        }
        reviewThreads(last: 100) {
          nodes {
            comments(first: 100) {
              nodes {
                url
                createdAt
                author {
                  __typename
                  login
                }
                reactions(content: THUMBS_UP, first: 100) {
                  nodes {
                    createdAt
                    reactor {
                      __typename
                      ... on Actor {
                        login
                      }
                    }
                  }
                }
              }
            }
          }
        }
        comments(last: 100) {
          nodes {
            url
            body
            createdAt
            author {
              __typename
              login
            }
            reactions(content: THUMBS_UP, first: 100) {
              nodes {
                createdAt
                reactor {
                  __typename
                  ... on Actor {
                    login
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

interface Reactions {
  nodes: { createdAt: string; reactor: { __typename: string; login?: string } | null }[];
}

interface AnswerComment {
  url: string;
  createdAt: string;
  author: Actor | null;
  reactions: Reactions;
}

interface FeedbackAnswersResponse {
  data?: {
    repository: {
      pullRequest: {
        reviews: { nodes: { url: string; reactions: Reactions }[] };
        reviewThreads: { nodes: { comments: { nodes: AnswerComment[] } }[] };
        comments: { nodes: (AnswerComment & { body: string })[] };
      } | null;
    } | null;
  };
  errors?: { message: string }[];
}

const BOT_SUFFIX = '[bot]';

const botLoginOf = (name: string): string =>
  (name.endsWith(BOT_SUFFIX) ? name.slice(0, -BOT_SUFFIX.length) : name).toLowerCase();

export const queryUnansweredFeedback = async (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
  appName: string,
  items: readonly FeedbackItem[],
): Promise<FeedbackItem[]> => {
  const response = await requestGraphql(fetch, token, FEEDBACK_ANSWERS_QUERY, github, { number });
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for ${github}#${number}`);
  }
  const { data, errors } = (await response.json()) as FeedbackAnswersResponse;
  const pullRequest = data?.repository?.pullRequest;
  if (pullRequest === undefined || pullRequest === null) {
    const reason =
      errors === undefined || errors.length === 0
        ? 'no such pull request'
        : errors.map((error) => error.message).join('; ');
    throw new Error(`GitHub found no pull request ${github}#${number}: ${reason}`);
  }
  const app = botLoginOf(appName);
  const instant = (time: string): number => Date.parse(time);
  const isApp = (actor: { __typename: string; login?: string } | null): boolean =>
    actor !== null && actor.__typename === 'Bot' && actor.login?.toLowerCase() === app;
  const reactedBy = (reactions: Reactions, since: string): boolean =>
    reactions.nodes.some(
      ({ createdAt, reactor }) => isApp(reactor) && instant(createdAt) > instant(since),
    );
  const reactionsByUrl = new Map<string, Reactions>([
    ...pullRequest.reviews.nodes.map(({ url, reactions }): [string, Reactions] => [url, reactions]),
    ...pullRequest.reviewThreads.nodes.flatMap(({ comments }) =>
      comments.nodes.map(({ url, reactions }): [string, Reactions] => [url, reactions]),
    ),
    ...pullRequest.comments.nodes.map(({ url, reactions }): [string, Reactions] => [url, reactions]),
  ]);
  const linking = pullRequest.comments.nodes.filter(({ author }) => isApp(author));
  const answered = (item: FeedbackItem): boolean => {
    const since = item.createdAt;
    const reacted = reactedBy(reactionsByUrl.get(item.url) ?? { nodes: [] }, since);
    const linked = linking.some(
      ({ body, createdAt }) => body.includes(item.url) && instant(createdAt) > instant(since),
    );
    const replied =
      item.kind === 'inline review comment' &&
      pullRequest.reviewThreads.nodes.some(
        ({ comments }) =>
          comments.nodes.some(({ url }) => url === item.url) &&
          comments.nodes.some(
            ({ url, author, createdAt }) =>
              url !== item.url && isApp(author) && instant(createdAt) > instant(since),
          ),
      );
    return reacted || linked || replied;
  };
  return items.filter((item) => !answered(item));
};
