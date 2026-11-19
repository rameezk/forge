import { latestLabelEvents } from './approval.ts';
import type { Fetch } from './frontier.ts';
import { FORGE_HOLD, hasLabel } from './labels.ts';
import type { MaintainerLookup } from './maintainers.ts';

export type Hold = 'none' | 'maintainer' | 'outsider';

export const holdOn = async (
  fetch: Fetch,
  token: string,
  github: string,
  number: number,
  isMaintainer: MaintainerLookup,
): Promise<Hold> => {
  if (!(await hasLabel(fetch, token, github, number, FORGE_HOLD))) return 'none';
  const applied = (await latestLabelEvents(fetch, token, github, number, [FORGE_HOLD], 'pullRequest')).get(FORGE_HOLD);
  return applied !== undefined && (await isMaintainer(applied.actor)) ? 'maintainer' : 'outsider';
};
