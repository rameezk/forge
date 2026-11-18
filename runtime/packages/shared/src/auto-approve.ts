import { FORGE_READY } from './dispatch.ts';
import { hasOutsiderEditSince } from './edits.ts';
import { errorMessage } from './errors.ts';
import type { Fetch, PolledTicket } from './frontier.ts';
import { relabel } from './labels.ts';
import { maintainerLookup } from './maintainers.ts';
import { latestLabelEvents, READY_FOR_AGENT } from './approval.ts';

export interface AutoApproveOptions {
  fetch: Fetch;
  token: () => Promise<string>;
  github: string;
  tickets: readonly PolledTicket[];
  log: (line: string) => void;
}

export const autoApproveTickets = async ({
  fetch,
  token,
  github,
  tickets,
  log,
}: AutoApproveOptions): Promise<{ labelled: Set<number>; failed: boolean }> => {
  const labelled = new Set<number>();
  let failed = false;
  const candidates = tickets.filter((ticket) => !ticket.forgeLabelled && !ticket.forHuman);
  if (candidates.length === 0) return { labelled, failed };
  let writeToken: string;
  try {
    writeToken = await token();
  } catch (error) {
    log(`${github}: could not auto-approve tickets: ${errorMessage(error)}`);
    return { labelled, failed: true };
  }
  const isMaintainer = maintainerLookup(fetch, writeToken, github);
  for (const ticket of candidates) {
    try {
      const events = await latestLabelEvents(fetch, writeToken, github, ticket.number, [
        READY_FOR_AGENT,
        FORGE_READY,
      ]);
      const approval = events.get(READY_FOR_AGENT);
      if (approval === undefined || !(await isMaintainer(approval.actor))) continue;
      const applied = events.get(FORGE_READY);
      if (applied !== undefined && applied.recency < approval.recency) continue;
      let edited = false;
      for (const { number } of ticket.parent === null ? [ticket] : [ticket, ticket.parent]) {
        if (await hasOutsiderEditSince(fetch, writeToken, github, number, approval.at, isMaintainer)) {
          edited = true;
          break;
        }
      }
      if (edited) continue;
      await relabel(fetch, writeToken, github, ticket.number, FORGE_READY, []);
      labelled.add(ticket.number);
    } catch (error) {
      log(`${github}#${ticket.number}: could not auto-approve: ${errorMessage(error)}`);
      failed = true;
    }
  }
  return { labelled, failed };
};
