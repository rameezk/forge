import { FORGE_RUNNING } from './dispatch.ts';
import { errorMessage } from './errors.ts';
import { queryLabelled, type Fetch } from './frontier.ts';
import { settleTicket } from './labels.ts';
import type { Workloads } from './store/workloads.ts';

export interface SettleRunningOptions {
  workloads: Workloads;
  fetch: Fetch;
  token: () => Promise<string>;
  repository: string;
  github: string;
  now: () => string;
  log: (line: string) => void;
}

export const settleRunningTickets = async ({
  workloads,
  fetch,
  token,
  repository,
  github,
  now,
  log,
}: SettleRunningOptions): Promise<boolean> => {
  try {
    const writeToken = await token();
    for (const issue of await queryLabelled(fetch, writeToken, github, FORGE_RUNNING)) {
      const settled = workloads.reconcileDispatch({ repository, ...issue }, now());
      if (settled === null) continue;
      await settleTicket(fetch, writeToken, github, issue.number, settled);
      log(`${repository}#${issue.number} was settled as ${settled}`);
    }
    return true;
  } catch (error) {
    log(
      `${repository}: could not settle tickets labelled ${FORGE_RUNNING}: ${errorMessage(error)}`,
    );
    return false;
  }
};
