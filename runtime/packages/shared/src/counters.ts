import type { HarnessEvent } from './events.ts';
import type { RunCounters } from './run.ts';

export const noCounters = (): RunCounters => ({
  toolCalls: 0,
  failedToolResults: 0,
  retries: 0,
  compactions: 0,
});

export const countEvent = (counters: RunCounters, event: HarnessEvent): void => {
  switch (event.type) {
    case 'tool_call':
      counters.toolCalls += 1;
      break;
    case 'tool_result':
      if (event.isError) {
        counters.failedToolResults += 1;
      }
      break;
    case 'retry':
      counters.retries += 1;
      break;
    case 'compaction':
      counters.compactions += 1;
      break;
    default:
      break;
  }
};

export const countEvents = (events: Iterable<HarnessEvent>): RunCounters => {
  const counters = noCounters();
  for (const event of events) {
    countEvent(counters, event);
  }
  return counters;
};
