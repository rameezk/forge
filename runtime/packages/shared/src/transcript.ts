import type { HarnessEvent } from './events.ts';

export const rawEventsRef = (runId: string): string =>
  `${runId}.events.jsonl`;

export const transcriptLine = (event: HarnessEvent): string =>
  `${JSON.stringify(event)}\n`;

export const parseTranscript = (contents: string): HarnessEvent[] =>
  contents
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as HarnessEvent);
