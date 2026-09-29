import type { MessageEvent, RunStatus, Store } from '@forge/shared';
import { invocationFor, type Harness, type Worker } from './harness.ts';
import { transcriptPolicy, type TranscriptWriter } from './transcript.ts';

export interface RunWorkloadOptions {
  store: Store;
  harness: Harness;
  worker: Worker;
  openTranscript: (runId: string) => TranscriptWriter;
  openWorkDir: (runId: string) => string;
  now: () => string;
  newId: () => string;
  secrets?: string[];
}

const isBillable = (event: MessageEvent): boolean =>
  event.role === 'assistant' &&
  (event.generationId !== null ||
    event.usage.inputTokens + event.usage.outputTokens > 0);

export const runWorkload = async (
  options: RunWorkloadOptions,
): Promise<string> => {
  const { store, harness, worker, openTranscript, openWorkDir, now, newId } =
    options;
  const policy = transcriptPolicy(options.secrets ?? []);
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
    costStatus: 'pending',
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    transcriptRef: transcript.ref,
    sessionId: null,
    error: null,
  });

  const recordGeneration = (event: MessageEvent): void => {
    if (event.generationId === null) {
      process.stderr.write(
        `run ${id}: an assistant response used tokens but has no generation id, so its cost is unconfirmed\n`,
      );
    }
    store.recordGeneration({
      runId: id,
      generationId: event.generationId,
      subagent: event.subagent ?? null,
      createdAt: now(),
    });
  };

  let inputTokens = 0;
  let outputTokens = 0;
  let status: RunStatus = 'error';
  let sessionId: string | null = null;
  let error: string | null = 'harness stream ended without a result';

  try {
    const invocation = invocationFor(worker, openWorkDir(id));
    for await (const harnessEvent of harness.run(invocation)) {
      const event = policy.record(harnessEvent);
      await transcript.append(event);
      if (event.type === 'message') {
        inputTokens += event.usage.inputTokens;
        outputTokens += event.usage.outputTokens;
        if (isBillable(event)) {
          recordGeneration(event);
        }
      } else if (event.type === 'result') {
        status = event.status;
        sessionId = event.sessionId;
        error = event.error;
      }
    }
  } catch (cause) {
    status = 'error';
    error = policy.redact(
      cause instanceof Error ? cause.message : String(cause),
    );
  } finally {
    await transcript.close();
  }

  store.finalizeRun(id, {
    endTime: now(),
    status,
    inputTokens,
    outputTokens,
    sessionId,
    error,
  });

  return id;
};
