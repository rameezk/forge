import { FORGE_READY } from './dispatch.ts';
import { readGraphql, requestGraphql, type Fetch } from './frontier.ts';
import type { Actor, MaintainerLookup } from './maintainers.ts';

export const TICKET_APPROVAL_QUERY = `
  query TicketApproval($owner: String!, $name: String!, $number: Int!, $before: String) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        timelineItems(last: 100, before: $before, itemTypes: [LABELED_EVENT]) {
          pageInfo {
            hasPreviousPage
            startCursor
          }
          nodes {
            __typename
            ... on LabeledEvent {
              createdAt
              label {
                name
              }
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

interface LabeledEventNode {
  label: { name: string };
  actor: Actor | null;
}

interface TicketApprovalResponse {
  repository: {
    issue: {
      timelineItems: {
        pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
        nodes: LabeledEventNode[];
      };
    } | null;
  } | null;
}

export const requestTicketApproval = (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
  before: string | null,
): Promise<Response> =>
  requestGraphql(fetch, token, TICKET_APPROVAL_QUERY, github, { number, before });

type ApprovalPage = NonNullable<
  NonNullable<NonNullable<TicketApprovalResponse['repository']>['issue']>
>['timelineItems'];

const queryApprovalPage = async (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
  before: string | null,
): Promise<ApprovalPage> => {
  const where = `${github}#${number}`;
  const data = await readGraphql<TicketApprovalResponse>(
    await requestTicketApproval(fetch, token, github, number, before),
    TICKET_APPROVAL_QUERY,
    where,
  );
  const issue = data?.repository?.issue;
  if (issue === undefined || issue === null) {
    throw new Error(`GitHub found no ticket ${where}`);
  }
  return issue.timelineItems;
};

export const isApprovedByMaintainer = async (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
  isMaintainer: MaintainerLookup,
): Promise<boolean> => {
  const cursors = new Set<string>();
  let before: string | null = null;
  do {
    const { pageInfo, nodes }: ApprovalPage = await queryApprovalPage(
      fetch,
      token,
      github,
      number,
      before,
    );
    const latest = nodes.findLast((node) => node.label?.name === FORGE_READY);
    if (latest !== undefined) return isMaintainer(latest.actor);
    before = pageInfo.hasPreviousPage ? pageInfo.startCursor : null;
    if (before !== null && cursors.has(before)) {
      throw new Error(`GitHub paging did not advance for ${github}#${number}`);
    }
    if (before !== null) cursors.add(before);
  } while (before !== null);
  return false;
};
