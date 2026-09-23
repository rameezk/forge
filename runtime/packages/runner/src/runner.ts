import type { RunStatus, Store } from '@forge/shared';
import { invocationFor, type Harness, type Worker } from './harness.ts';
import type { TranscriptWriter } from './transcript.ts';

export interface RunWorkloadOptions {
  store: Store;
  harness: Harness;
  worker: Worker;
  openTranscript: (runId: string) => TranscriptWriter;
  now: () => string;
  newId: () => string;
}

export const runWorkload = async (
  options: RunWorkloadOptions,
): Promise<string> => {
  const { store, harness, worker, openTranscript, now, newId } = options;
  const id = newId();
  const transcript = openTranscript(id);

  store.insertRun({
    id,
    worker: worker.name,
    harness: worker.harness,
    model: worker.model,
    startTime: now(),
    endTime: null,
    status: 'running',
    costUncertain: false,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    transcriptRef: transcript.ref,
    sessionId: null,
    error: null,
  });

  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let status: RunStatus = 'error';
  let sessionId: string | null = null;
  let error: string | null = 'harness stream ended without a result';

  try {
    for await (const event of harness.run(invocationFor(worker))) {
      await transcript.append(event);
      if (event.type === 'message') {
        inputTokens += event.usage.inputTokens;
        outputTokens += event.usage.outputTokens;
        costUsd += event.costUsd;
      } else {
        status = event.status;
        sessionId = event.sessionId;
        error = event.error;
      }
    }
  } catch (cause) {
    status = 'error';
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    await transcript.close();
  }

  store.finalizeRun(id, {
    endTime: now(),
    status,
    costUncertain: status === 'success' && outputTokens > 0 && costUsd === 0,
    costUsd,
    inputTokens,
    outputTokens,
    sessionId,
    error,
  });

  return id;
};
