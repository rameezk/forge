import { FORGE_READY } from './dispatch.ts';
import { BLOCKERS_PAGE_SIZE, isGithubUrl, readGraphql, requestGraphql, type Fetch } from './frontier.ts';
import { GITHUB_REST_API } from './github-api.ts';
import { relabel, requestRest } from './labels.ts';

const ASSIGNEES_PAGE_SIZE = 20;

export const OPERATOR_TICKET_QUERY = `
  query OperatorTicket($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        url
        state
        labels(first: 100) {
          nodes {
            name
          }
        }
        assignees(first: ${ASSIGNEES_PAGE_SIZE}) {
          nodes {
            login
          }
        }
        blockedBy(first: ${BLOCKERS_PAGE_SIZE}) {
          nodes {
            number
            state
          }
        }
      }
    }
  }
`;

export interface OperatorTicket {
  url: string;
  open: boolean;
  labels: string[];
  assignees: string[];
  blockedBy: number[];
}

interface OperatorTicketResponse {
  repository: {
    issue: {
      url: string;
      state: string;
      labels: { nodes: { name: string }[] };
      assignees: { nodes: { login: string }[] };
      blockedBy: { nodes: { number: number; state: string }[] };
    } | null;
  } | null;
}

export const queryOperatorTicket = async (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
): Promise<OperatorTicket> => {
  const where = `${github}#${number}`;
  const data = await readGraphql<OperatorTicketResponse>(
    await requestGraphql(fetch, token, OPERATOR_TICKET_QUERY, github, { number }),
    OPERATOR_TICKET_QUERY,
    where,
  );
  const issue = data?.repository?.issue;
  if (issue === undefined || issue === null) {
    throw new Error(`GitHub found no ticket ${where}`);
  }
  if (!isGithubUrl(issue.url)) {
    throw new Error(`GitHub returned an unexpected issue URL '${issue.url}'`);
  }
  return {
    url: issue.url,
    open: issue.state === 'OPEN',
    labels: issue.labels.nodes.map(({ name }) => name),
    assignees: issue.assignees.nodes.map(({ login }) => login),
    blockedBy: issue.blockedBy.nodes.filter(({ state }) => state === 'OPEN').map(({ number: blocker }) => blocker),
  };
};

export const queryViewerLogin = async (fetch: Fetch, token: string): Promise<string> => {
  const response = await fetch(`${GITHUB_REST_API}/user`, {
    headers: { authorization: `bearer ${token}`, accept: 'application/vnd.github+json' },
  });
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for the signed-in user`);
  }
  return ((await response.json()) as { login: string }).login;
};

export const applyForgeReady = (fetch: Fetch, token: string, github: string, number: number): Promise<void> =>
  relabel(fetch, token, github, number, FORGE_READY, []);

export const assign = async (fetch: Fetch, token: string, github: string, number: number, login: string): Promise<void> => {
  const response = await requestRest(fetch, token, 'POST', github, `/issues/${number}/assignees`, { assignees: [login] });
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} assigning ${login} to ${github}#${number}`);
  }
};

export const unassign = async (fetch: Fetch, token: string, github: string, number: number, login: string): Promise<void> => {
  const response = await requestRest(fetch, token, 'DELETE', github, `/issues/${number}/assignees`, { assignees: [login] });
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} unassigning ${login} from ${github}#${number}`);
  }
};
