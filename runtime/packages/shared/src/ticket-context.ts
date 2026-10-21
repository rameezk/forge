import { readGraphql, requestGraphql, type Fetch } from './frontier.ts';
import { maintainerLookup, type Actor } from './maintainers.ts';

export const TICKET_CONTEXT_QUERY = `
  query TicketContext($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        ...ContextIssue
        parent {
          ...ContextIssue
        }
      }
    }
  }

  fragment ContextIssue on Issue {
    number
    title
    url
    body
    comments(last: 100) {
      nodes {
        url
        body
        author {
          __typename
          login
        }
      }
    }
  }
`;

interface ContextNode {
  number: number;
  title: string;
  url: string;
  body: string;
  comments: { nodes: { url: string; body: string; author: Actor | null }[] };
}

interface TicketContextResponse {
  repository: { issue: (ContextNode & { parent: ContextNode | null }) | null } | null;
}

export interface ContextComment {
  author: string;
  url: string;
  body: string;
}

export interface ContextIssue {
  number: number;
  title: string;
  url: string;
  body: string;
  comments: ContextComment[];
}

export interface TicketContext {
  ticket: ContextIssue;
  spec: ContextIssue | null;
}

export const requestTicketContext = (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
): Promise<Response> =>
  requestGraphql(fetch, token, TICKET_CONTEXT_QUERY, github, { number });

export const queryTicketContext = async (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
): Promise<TicketContext> => {
  const data = await readGraphql<TicketContextResponse>(
    await requestTicketContext(fetch, token, github, number),
    TICKET_CONTEXT_QUERY,
    `${github}#${number}`,
  );
  const issue = data?.repository?.issue;
  if (issue === undefined || issue === null) {
    throw new Error(`GitHub found no ticket ${github}#${number}`);
  }
  const isMaintainer = maintainerLookup(fetch, token, github);
  const contextOf = async (node: ContextNode): Promise<ContextIssue> => {
    const kept = await Promise.all(
      node.comments.nodes.map(async ({ author }) => await isMaintainer(author)),
    );
    return {
      number: node.number,
      title: node.title,
      url: node.url,
      body: node.body,
      comments: node.comments.nodes.flatMap(({ url, body, author }, index) =>
        kept[index] === true && author !== null ? [{ author: author.login, url, body }] : [],
      ),
    };
  };
  return {
    ticket: await contextOf(issue),
    spec: issue.parent === null ? null : await contextOf(issue.parent),
  };
};
