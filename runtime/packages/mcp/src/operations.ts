import { READY_FOR_AGENT, type RepositoryView, type RunningPullRequestWorkload, type RunningView, type RunningWorkload, type TicketView } from '@forge/shared';
import type { Box } from './box.ts';
import type { GitHub } from './github.ts';

export interface OperationsDeps {
  box: Box;
  github: GitHub;
}

export interface TicketInput {
  repository: string;
  number: number;
}

export type DispatchResult = { dispatched: true; queued: boolean; message: string } | { dispatched: false; reason: string };

export interface ClaimResult {
  claimed: true;
  assignee: string;
  warning: string | null;
  prompt: { description: string; text: string } | null;
}

export type ReleaseResult = { released: true; assignee: string } | { released: false; reason: string };

export interface Operations {
  ticket(input: TicketInput): Promise<TicketView>;
  running(): Promise<RunningView>;
  dispatch(input: TicketInput): Promise<DispatchResult>;
  claim(input: TicketInput): Promise<ClaimResult>;
  release(input: TicketInput): Promise<ReleaseResult>;
}

const fillPrompt = (template: string, github: string, number: number, url: string): string =>
  template.replaceAll('{repo}', github).replaceAll('{issue}', String(number)).replaceAll('{url}', url);

const repositoryNamed = async (box: Box, name: string): Promise<RepositoryView> => {
  const repositories = await box.repositories();
  const repository = repositories.find((candidate) => candidate.name === name);
  if (repository === undefined) {
    throw new Error(`forge manages no repository named ${JSON.stringify(name)}; it manages ${repositories.map((candidate) => candidate.name).join(', ') || 'none'}`);
  }
  return repository;
};

const linked = <Workload extends RunningWorkload>(box: Box, workload: Workload): Workload => ({
  ...workload,
  dashboard: workload.dashboard === null ? null : box.link(workload.dashboard),
});

export const createOperations = ({ box, github }: OperationsDeps): Operations => ({
  async ticket({ repository, number }) {
    const ticket = await box.ticket(repository, number);
    return {
      ...ticket,
      dashboard: box.link(ticket.dashboard),
      attempts: ticket.attempts.map((attempt) => ({ ...attempt, dashboard: box.link(attempt.dashboard) })),
    };
  },

  async running() {
    const running = await box.running();
    const pullRequests = (workloads: RunningPullRequestWorkload[]) => workloads.map((workload) => linked(box, workload));
    return {
      dispatches: running.dispatches.map((dispatch) => linked(box, dispatch)),
      revisions: pullRequests(running.revisions),
      conflictResolutions: pullRequests(running.conflictResolutions),
    };
  },

  async dispatch({ repository: name, number }) {
    const repository = await repositoryNamed(box, name);
    const issue = await github.issue(repository.github, number);
    const refuse = (reason: string): DispatchResult => ({ dispatched: false, reason });
    if (!issue.open) return refuse(`${repository.github}#${number} is closed`);
    if (!issue.labels.includes(READY_FOR_AGENT)) return refuse(`${repository.github}#${number} is not labelled ${READY_FOR_AGENT}, so forge cannot take it`);
    if (issue.assignees.length > 0) {
      return refuse(`${repository.github}#${number} is assigned to ${issue.assignees.join(', ')}; forge leaves assigned tickets to their assignee. Release it first to hand it back to forge`);
    }
    await github.applyForgeReady(repository.github, number);
    if (issue.blockedBy.length > 0) {
      const blockers = issue.blockedBy.map((blocker) => `#${blocker}`).join(', ');
      return { dispatched: true, queued: true, message: `forge:ready applied to ${repository.github}#${number}; it is queued behind ${blockers} and starts once ${issue.blockedBy.length === 1 ? 'it is' : 'they are'} done` };
    }
    return { dispatched: true, queued: false, message: `forge:ready applied to ${repository.github}#${number}; forge starts it on its next dispatch pass` };
  },

  async claim({ repository: name, number }) {
    const repository = await repositoryNamed(box, name);
    const [operator, issue, running] = await Promise.all([github.operator(), github.issue(repository.github, number), box.running()]);
    await github.assign(repository.github, number, operator);
    const live = running.dispatches.some(({ ticket }) => ticket.repository === name && ticket.number === number);
    return {
      claimed: true,
      assignee: operator,
      warning: live ? `a forge workload is running on ${repository.github}#${number}; assigning it does not interrupt that run, so the two may both work the ticket` : null,
      prompt:
        repository.ticketPrompt === null
          ? null
          : { description: `How forge works tickets in ${name}: run this in your agent to take the same path`, text: fillPrompt(repository.ticketPrompt, repository.github, number, issue.url) },
    };
  },

  async release({ repository: name, number }) {
    const repository = await repositoryNamed(box, name);
    const [operator, issue] = await Promise.all([github.operator(), github.issue(repository.github, number)]);
    if (!issue.assignees.includes(operator)) return { released: false, reason: `${repository.github}#${number} is not assigned to ${operator}` };
    await github.unassign(repository.github, number, operator);
    return { released: true, assignee: operator };
  },
});
