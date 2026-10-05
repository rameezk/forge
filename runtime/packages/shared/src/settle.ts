import { FORGE_DONE, FORGE_FAILED, FORGE_READY, FORGE_RUNNING } from './dispatch.ts';
import { errorMessage } from './errors.ts';
import { queryLabelled, type Fetch } from './frontier.ts';
import { relabel } from './labels.ts';
import type { Store } from './store.ts';

export interface SettleRunningOptions {
  store: Store;
  fetch: Fetch;
  token: () => string;
  repository: string;
  github: string;
  now: () => string;
  log: (line: string) => void;
}

/**
 * Moves each of a repository's `forge:running` tickets whose dispatch has
 * ended or stopped beating to `forge:done` or `forge:failed`, logging each one.
 * Returns false, after logging why, when the token could not be read or
 * GitHub could not be read or written.
 */
export const settleRunningTickets = async ({
  store,
  fetch,
  token,
  repository,
  github,
  now,
  log,
}: SettleRunningOptions): Promise<boolean> => {
  try {
    const writeToken = token();
    for (const issue of await queryLabelled(fetch, writeToken, github, FORGE_RUNNING)) {
      const settled = store.reconcileDispatch({ repository, ...issue }, now());
      if (settled === null) continue;
      await relabel(
        fetch,
        writeToken,
        github,
        issue.number,
        settled === 'done' ? FORGE_DONE : FORGE_FAILED,
        [FORGE_RUNNING, FORGE_READY],
      );
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
