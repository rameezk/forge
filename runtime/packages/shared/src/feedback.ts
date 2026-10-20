import {
  pullRequestUrl,
  readGraphql,
  requestGraphql,
  type Fetch,
  type Mergeable,
} from './frontier.ts';
import { maintainerLookup, type Actor, type MaintainerLookup } from './maintainers.ts';

export const WATCHED_PAGE_SIZE = 50;

export const WATCHED_PULL_REQUESTS_QUERY = `
  query WatchedPullRequests($owner: String!, $name: String!, $first: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      defaultBranchRef {
        target {
          oid
        }
      }
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
          mergeable
          headRefOid
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
              createdAt
            }
          }
        }
      }
    }
  }
`;

interface WatchedNode {
  number: number;
  url: string;
  mergeable: Mergeable;
  headRefOid: string;
  author: Actor | null;
  closingIssuesReferences: {
    nodes: { number: number; repository: { nameWithOwner: string } }[];
  };
  reviews: {
    nodes: {
      author: Actor | null;
      body: string;
      submittedAt: string | null;
      comments: { totalCount: number };
    }[];
  };
  comments: { nodes: { author: Actor | null; createdAt: string }[] };
}

interface WatchedPage {
  defaultBranchRef: { target: { oid: string } | null } | null;
  pullRequests: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: WatchedNode[];
  };
}

interface WatchedResponse {
  repository: WatchedPage | null;
}

export interface WatchedPullRequest {
  number: number;
  url: string;
  closes: number[];
  newestFeedbackAt: string | null;
  mergeable: Mergeable;
  headSha: string;
  defaultSha: string;
}

const newest = (times: string[]): string | null =>
  times.reduce<string | null>((latest, time) => (latest === null || time > latest ? time : latest), null);

const newestFeedback = async (node: WatchedNode, isMaintainer: MaintainerLookup): Promise<string | null> => {
  const times = await Promise.all([
    ...node.reviews.nodes.map(async (review) =>
      review.submittedAt !== null &&
      (review.body.trim() !== '' || review.comments.totalCount > 0) &&
      (await isMaintainer(review.author))
        ? [review.submittedAt]
        : [],
    ),
    ...node.comments.nodes.map(async (comment) =>
      (await isMaintainer(comment.author)) ? [comment.createdAt] : [],
    ),
  ]);
  return newest(times.flat());
};

const toWatched = async (
  node: WatchedNode,
  github: string,
  defaultSha: string,
  isMaintainer: MaintainerLookup,
): Promise<WatchedPullRequest> => ({
  number: node.number,
  url: pullRequestUrl(node.url),
  closes: node.closingIssuesReferences.nodes
    .filter((issue) => issue.repository.nameWithOwner.toLowerCase() === github.toLowerCase())
    .map((issue) => issue.number),
  newestFeedbackAt: await newestFeedback(node, isMaintainer),
  mergeable: node.mergeable,
  headSha: node.headRefOid,
  defaultSha,
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
  const data = await readGraphql<WatchedResponse>(response, WATCHED_PULL_REQUESTS_QUERY, github);
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
  const isMaintainer = maintainerLookup(fetch, token, github);
  const cursors = new Set<string>();
  let after: string | null = null;
  do {
    const { pullRequests, defaultBranchRef } = await queryWatchedPage(fetch, token, github, after);
    const defaultSha = defaultBranchRef?.target?.oid;
    if (defaultSha === undefined) {
      throw new Error(`GitHub reported no default branch for ${github}`);
    }
    watched.push(
      ...(await Promise.all(
        pullRequests.nodes
          .filter(
            ({ author }) =>
              author?.__typename === 'Bot' && author.login.toLowerCase() === appLogin.toLowerCase(),
          )
          .map((node) => toWatched(node, github, defaultSha, isMaintainer)),
      )),
    );
    after = pullRequests.pageInfo.hasNextPage ? pullRequests.pageInfo.endCursor : null;
    if (after !== null && cursors.has(after)) {
      throw new Error(`GitHub paging did not advance for ${github}`);
    }
    if (after !== null) cursors.add(after);
  } while (after !== null);
  return watched;
};

export const FEEDBACK_WINDOW_QUERY = `
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
            body
            submittedAt
            comments(first: 100) {
              nodes {
                url
                author {
                  __typename
                  login
                }
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
  body: string;
}

interface FeedbackWindowResponse {
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
  const data = await readGraphql<FeedbackWindowResponse>(
    await requestGraphql(fetch, token, FEEDBACK_WINDOW_QUERY, github, { number }),
    FEEDBACK_WINDOW_QUERY,
    `${github}#${number}`,
  );
  const pullRequest = data?.repository?.pullRequest;
  if (pullRequest === undefined || pullRequest === null) {
    throw new Error(`GitHub found no pull request ${github}#${number}`);
  }
  const instant = (time: string): number => Date.parse(time);
  const inWindow = (time: string): boolean =>
    (after === null || instant(time) > instant(after)) && instant(time) <= instant(until);
  const isMaintainer = maintainerLookup(fetch, token, github);
  const keep = async <Node extends AuthoredNode>(
    nodes: Node[],
    at: (node: Node) => string | null,
  ): Promise<Node[]> => {
    const counted = await Promise.all(
      nodes.map(async (node) => {
        const time = at(node);
        return time !== null && inWindow(time) && (await isMaintainer(node.author));
      }),
    );
    return nodes.filter((_, index) => counted[index]);
  };
  const reviews = await keep(pullRequest.reviews.nodes, (review) => review.submittedAt);
  const inline = await keep(
    pullRequest.reviews.nodes.flatMap((review) => review.comments.nodes),
    (comment) => comment.createdAt,
  );
  const conversation = await keep(pullRequest.comments.nodes, (comment) => comment.createdAt);
  const items: FeedbackItem[] = [
    ...reviews.flatMap((review): FeedbackItem[] =>
      review.body.trim() !== ''
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
        : [],
    ),
    ...inline.map((comment) => ({
      kind: 'inline review comment' as const,
      author: authorOf(comment.author),
      url: comment.url,
      body: comment.body,
      createdAt: comment.createdAt,
      path: comment.path,
      line: comment.line ?? comment.originalLine,
    })),
    ...conversation.map((comment) => ({
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

export const FEEDBACK_ANSWERS_QUERY = `
  query FeedbackAnswers($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviews(last: 100) {
          nodes {
            url
            ...ThumbsUp
          }
        }
        reviewThreads(last: 100) {
          nodes {
            comments(first: 40) {
              nodes {
                url
                createdAt
                author {
                  __typename
                  login
                }
                ...ThumbsUp
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
            ...ThumbsUp
          }
        }
      }
    }
  }

  fragment ThumbsUp on Reactable {
    reactionGroups {
      content
      reactors(first: 100) {
        edges {
          reactedAt
          node {
            __typename
            ... on Actor {
              login
            }
          }
        }
      }
    }
  }
`;

interface ReactionGroup {
  content: string;
  reactors: {
    edges: { reactedAt: string; node: { __typename: string; login?: string } | null }[];
  };
}

type Reactions = ReactionGroup[];

interface AnswerComment {
  url: string;
  createdAt: string;
  author: Actor | null;
  reactionGroups: Reactions;
}

interface FeedbackAnswersResponse {
  repository: {
    pullRequest: {
      reviews: { nodes: { url: string; reactionGroups: Reactions }[] };
      reviewThreads: { nodes: { comments: { nodes: AnswerComment[] } }[] };
      comments: { nodes: (AnswerComment & { body: string })[] };
    } | null;
  } | null;
}

const BOT_SUFFIX = '[bot]';

const URL_CHARACTER = /[A-Za-z0-9_-]/;

const mentions = (body: string, url: string): boolean => {
  for (let at = body.indexOf(url); at !== -1; at = body.indexOf(url, at + 1)) {
    if (!URL_CHARACTER.test(body[at + url.length] ?? '')) return true;
  }
  return false;
};

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
  const data = await readGraphql<FeedbackAnswersResponse>(
    await requestGraphql(fetch, token, FEEDBACK_ANSWERS_QUERY, github, { number }),
    FEEDBACK_ANSWERS_QUERY,
    `${github}#${number}`,
  );
  const pullRequest = data?.repository?.pullRequest;
  if (pullRequest === undefined || pullRequest === null) {
    throw new Error(`GitHub found no pull request ${github}#${number}`);
  }
  const app = botLoginOf(appName);
  const instant = (time: string): number => Date.parse(time);
  const isApp = (actor: { __typename: string; login?: string } | null): boolean =>
    actor !== null && actor.__typename === 'Bot' && actor.login?.toLowerCase() === app;
  const reactedBy = (reactions: Reactions, since: string): boolean =>
    reactions.some(
      ({ content, reactors }) =>
        content === 'THUMBS_UP' &&
        reactors.edges.some(
          ({ reactedAt, node }) => isApp(node) && instant(reactedAt) > instant(since),
        ),
    );
  const reactionsByUrl = new Map<string, Reactions>([
    ...pullRequest.reviews.nodes.map(({ url, reactionGroups }): [string, Reactions] => [
      url,
      reactionGroups,
    ]),
    ...pullRequest.reviewThreads.nodes.flatMap(({ comments }) =>
      comments.nodes.map(({ url, reactionGroups }): [string, Reactions] => [url, reactionGroups]),
    ),
    ...pullRequest.comments.nodes.map(({ url, reactionGroups }): [string, Reactions] => [
      url,
      reactionGroups,
    ]),
  ]);
  const linking = pullRequest.comments.nodes.filter(({ author }) => isApp(author));
  const answered = (item: FeedbackItem): boolean => {
    const since = item.createdAt;
    const reacted = reactedBy(reactionsByUrl.get(item.url) ?? [], since);
    const linked = linking.some(
      ({ body, createdAt }) => mentions(body, item.url) && instant(createdAt) > instant(since),
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
