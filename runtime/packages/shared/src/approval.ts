import { FORGE_READY } from './dispatch.ts';
import { readGraphql, READY_FOR_AGENT, requestGraphql, type Fetch } from './frontier.ts';
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
  createdAt: string;
  label: { name: string } | null;
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

export interface LabelEvent {
  at: string;
  actor: Actor | null;
  recency: number;
}

export const latestLabelEvents = async (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
  labels: readonly string[],
): Promise<Map<string, LabelEvent>> => {
  const latest = new Map<string, LabelEvent>();
  const cursors = new Set<string>();
  let before: string | null = null;
  let recency = 0;
  do {
    const { pageInfo, nodes }: ApprovalPage = await queryApprovalPage(
      fetch,
      token,
      github,
      number,
      before,
    );
    for (const node of nodes.toReversed()) {
      const name = node.label?.name;
      if (name !== undefined && labels.includes(name) && !latest.has(name)) {
        latest.set(name, { at: node.createdAt, actor: node.actor, recency });
      }
      recency += 1;
    }
    if (latest.size === labels.length) break;
    before = pageInfo.hasPreviousPage ? pageInfo.startCursor : null;
    if (before !== null && cursors.has(before)) {
      throw new Error(`GitHub paging did not advance for ${github}#${number}`);
    }
    if (before !== null) cursors.add(before);
  } while (before !== null);
  return latest;
};

const reappliedByOutsider = (applied: LabelEvent | undefined, approval: LabelEvent): boolean =>
  applied !== undefined &&
  applied.recency < approval.recency &&
  applied.actor?.__typename !== 'Bot';

export const maintainerApprovalOf = async (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
  isMaintainer: MaintainerLookup,
  autoApprove = false,
): Promise<string | null> => {
  const anchors = autoApprove ? [FORGE_READY, READY_FOR_AGENT] : [FORGE_READY];
  const events = await latestLabelEvents(fetch, token, github, number, anchors);
  const applied = events.get(FORGE_READY);
  const approvals: string[] = [];
  for (const anchor of anchors) {
    const event = events.get(anchor);
    if (event === undefined || !(await isMaintainer(event.actor))) continue;
    if (anchor === READY_FOR_AGENT && reappliedByOutsider(applied, event)) continue;
    approvals.push(event.at);
  }
  return approvals.length === 0 ? null : approvals.reduce((a, b) => (a >= b ? a : b));
};
