import type { RunningPullRequestWorkload, RunningView, RunningWorkload, TicketView } from '@forge/shared';
import type { Box } from './box.ts';

export interface OperationsDeps {
  box: Box;
}

export interface Operations {
  ticket(input: { repository: string; number: number }): Promise<TicketView>;
  running(): Promise<RunningView>;
}

const linked = <Workload extends RunningWorkload>(box: Box, workload: Workload): Workload => ({
  ...workload,
  dashboard: workload.dashboard === null ? null : box.link(workload.dashboard),
});

export const createOperations = ({ box }: OperationsDeps): Operations => ({
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
});
