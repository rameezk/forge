import { readGraphql, requestGraphql, type Fetch } from './frontier.ts';
import type { Actor, MaintainerLookup } from './maintainers.ts';

export const TICKET_RENAMES_QUERY = `
  query TicketRenames($owner: String!, $name: String!, $number: Int!, $before: String) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        timelineItems(last: 100, before: $before, itemTypes: [RENAMED_TITLE_EVENT]) {
          pageInfo {
            hasPreviousPage
            startCursor
          }
          nodes {
            __typename
            ... on RenamedTitleEvent {
              createdAt
              actor {
                __typename
                login
              }
            }
          }
        }
      }
    }
  }
`;

export const TICKET_BODY_EDITS_QUERY = `
  query TicketBodyEdits($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        userContentEdits(first: 100, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            editedAt
            editor {
              __typename
              login
            }
          }
        }
      }
    }
  }
`;

interface Edit {
  at: string;
  by: Actor | null;
}

interface EditPage {
  edits: Edit[];
  cursor: string | null;
}

interface RenamesResponse {
  repository: {
    issue: {
      timelineItems: {
        pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
        nodes: { createdAt: string; actor: Actor | null }[];
      };
    } | null;
  } | null;
}

interface BodyEditsResponse {
  repository: {
    issue: {
      userContentEdits: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: { editedAt: string; editor: Actor | null }[];
      } | null;
    } | null;
  } | null;
}

export const requestTicketRenames = (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
  before: string | null,
): Promise<Response> =>
  requestGraphql(fetch, token, TICKET_RENAMES_QUERY, github, { number, before });

export const requestTicketBodyEdits = (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
  after: string | null,
): Promise<Response> =>
  requestGraphql(fetch, token, TICKET_BODY_EDITS_QUERY, github, { number, after });

const renamesPage = async (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
  before: string | null,
): Promise<EditPage> => {
  const where = `${github}#${number}`;
  const data = await readGraphql<RenamesResponse>(
    await requestTicketRenames(fetch, token, github, number, before),
    TICKET_RENAMES_QUERY,
    where,
  );
  const issue = data?.repository?.issue;
  if (issue === undefined || issue === null) {
    throw new Error(`GitHub found no ticket ${where}`);
  }
  const { pageInfo, nodes } = issue.timelineItems;
  return {
    edits: nodes.map(({ createdAt, actor }) => ({ at: createdAt, by: actor })).reverse(),
    cursor: pageInfo.hasPreviousPage ? pageInfo.startCursor : null,
  };
};

const bodyEditsPage = async (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
  after: string | null,
): Promise<EditPage> => {
  const where = `${github}#${number}`;
  const data = await readGraphql<BodyEditsResponse>(
    await requestTicketBodyEdits(fetch, token, github, number, after),
    TICKET_BODY_EDITS_QUERY,
    where,
  );
  const issue = data?.repository?.issue;
  if (issue === undefined || issue === null) {
    throw new Error(`GitHub found no ticket ${where}`);
  }
  const edits = issue.userContentEdits;
  return {
    edits: (edits?.nodes ?? []).map(({ editedAt, editor }) => ({ at: editedAt, by: editor })),
    cursor: edits?.pageInfo.hasNextPage ? edits.pageInfo.endCursor : null,
  };
};

const hasOutsiderEditIn = async (
  page: (cursor: string | null) => Promise<EditPage>,
  since: number,
  isMaintainer: MaintainerLookup,
  where: string,
): Promise<boolean> => {
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const { edits, cursor: next }: EditPage = await page(cursor);
    const recent = edits.filter(({ at }) => Date.parse(at) >= since);
    for (const { by } of recent) {
      if (!(await isMaintainer(by))) return true;
    }
    if (recent.length < edits.length) return false;
    cursor = next;
    if (cursor !== null && cursors.has(cursor)) {
      throw new Error(`GitHub paging did not advance for the edits of ${where}`);
    }
    if (cursor !== null) cursors.add(cursor);
  } while (cursor !== null);
  return false;
};

export const hasOutsiderEditSince = async (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
  since: string,
  isMaintainer: MaintainerLookup,
): Promise<boolean> => {
  const from = Date.parse(since);
  if (Number.isNaN(from)) {
    throw new Error(`GitHub gave an unreadable approval time for ${github}#${number}: ${since}`);
  }
  const where = `${github}#${number}`;
  return (
    (await hasOutsiderEditIn(
      (cursor) => renamesPage(fetch, token, github, number, cursor),
      from,
      isMaintainer,
      where,
    )) ||
    (await hasOutsiderEditIn(
      (cursor) => bodyEditsPage(fetch, token, github, number, cursor),
      from,
      isMaintainer,
      where,
    ))
  );
};
