import { FORGE_READY } from './dispatch.ts';
import { readGraphql, READY_FOR_AGENT, requestGraphql, type Fetch } from './frontier.ts';
import type { Actor, MaintainerLookup } from './maintainers.ts';

type LabelledSubject = 'issue' | 'pullRequest';

const labelEventsQuery = (name: string, subject: LabelledSubject): string => `
  query ${name}($owner: String!, $name: String!, $number: Int!, $before: String) {
    repository(owner: $owner, name: $name) {
      ${subject}(number: $number) {
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

export const TICKET_APPROVAL_QUERY = labelEventsQuery('TicketApproval', 'issue');

export const PULL_REQUEST_LABEL_EVENTS_QUERY = labelEventsQuery('PullRequestLabelEvents', 'pullRequest');

interface LabeledEventNode {
  createdAt: string;
  label: { name: string } | null;
  actor: Actor | null;
}

interface LabelledTimeline {
  timelineItems: {
    pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
    nodes: LabeledEventNode[];
  };
}

interface LabelEventsResponse {
  repository: {
    issue?: LabelledTimeline | null;
    pullRequest?: LabelledTimeline | null;
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

type ApprovalPage = LabelledTimeline['timelineItems'];

const queryApprovalPage = async (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
  before: string | null,
  subject: LabelledSubject,
): Promise<ApprovalPage> => {
  const where = `${github}#${number}`;
  const query = subject === 'issue' ? TICKET_APPROVAL_QUERY : PULL_REQUEST_LABEL_EVENTS_QUERY;
  const data = await readGraphql<LabelEventsResponse>(
    await requestGraphql(fetch, token, query, github, { number, before }),
    query,
    where,
  );
  const found = data?.repository?.[subject];
  if (found === undefined || found === null) {
    throw new Error(`GitHub found no ${subject === 'issue' ? 'ticket' : 'pull request'} ${where}`);
  }
  return found.timelineItems;
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
  subject: LabelledSubject = 'issue',
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
      subject,
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

const BOT_SUFFIX = '[bot]';

const slugOf = (login: string): string =>
  (login.endsWith(BOT_SUFFIX) ? login.slice(0, -BOT_SUFFIX.length) : login).toLowerCase();

export interface AutoApproval {
  forgeLogin: string;
}

const reappliedByOutsider = (
  applied: LabelEvent | undefined,
  approval: LabelEvent,
  { forgeLogin }: AutoApproval,
): boolean =>
  applied !== undefined &&
  applied.recency < approval.recency &&
  !(
    applied.actor?.__typename === 'Bot' && slugOf(applied.actor.login) === slugOf(forgeLogin)
  );

export const maintainerApprovalOf = async (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
  isMaintainer: MaintainerLookup,
  autoApproval: AutoApproval | null = null,
): Promise<string | null> => {
  const anchors = autoApproval === null ? [FORGE_READY] : [FORGE_READY, READY_FOR_AGENT];
  const events = await latestLabelEvents(fetch, token, github, number, anchors);
  const applied = events.get(FORGE_READY);
  const approvals: string[] = [];
  for (const anchor of anchors) {
    const event = events.get(anchor);
    if (event === undefined || !(await isMaintainer(event.actor))) continue;
    if (
      anchor === READY_FOR_AGENT &&
      autoApproval !== null &&
      reappliedByOutsider(applied, event, autoApproval)
    ) {
      continue;
    }
    approvals.push(event.at);
  }
  return approvals.length === 0 ? null : approvals.reduce((a, b) => (a >= b ? a : b));
};
