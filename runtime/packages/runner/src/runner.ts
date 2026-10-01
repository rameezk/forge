import type { MessageEvent, RunStatus, RunTicket, Store } from '@forge/shared';
import {
  invocationFor,
  type Harness,
  type Worker,
  type Workspace,
} from './harness.ts';
import { transcriptPolicy, type TranscriptWriter } from './transcript.ts';

export interface RunWorkloadOptions {
  store: Store;
  harness: Harness;
  worker: Worker;
  openTranscript: (runId: string) => TranscriptWriter;
  openWorkspace: (runId: string) => Workspace | Promise<Workspace>;
  now: () => string;
  newId: () => string;
  secrets?: string[];
  ticket?: RunTicket;
}

export interface WorkloadResult {
  id: string;
  finalMessage: string | null;
  cause: unknown;
}

const isBillable = (event: MessageEvent): boolean =>
  event.role === 'assistant' &&
  (event.generationId !== null ||
    Object.values(event.usage).some((count) => count > 0));

export const runWorkload = async (
  options: RunWorkloadOptions,
): Promise<WorkloadResult> => {
  const { store, harness, worker, openTranscript, openWorkspace, now, newId } =
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
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    transcriptRef: transcript.ref,
    sessionId: null,
    error: null,
    ticket: options.ticket ?? null,
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
      usage: event.usage,
      createdAt: now(),
    });
  };

  let status: RunStatus = 'error';
  let sessionId: string | null = null;
  let error: string | null = 'harness stream ended without a result';
  let finalMessage: string | null = null;
  let thrown: unknown = null;

  try {
    await transcript.append(
      policy.record({
        type: 'message',
        role: 'user',
        text: worker.prompt,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        generationId: null,
      }),
    );
    const invocation = invocationFor(worker, await openWorkspace(id));
    for await (const harnessEvent of harness.run(invocation)) {
      const event = policy.record(harnessEvent);
      await transcript.append(event);
      if (event.type === 'message') {
        if (isBillable(event)) {
          recordGeneration(event);
        }
        if (
          event.role === 'assistant' &&
          event.subagent === undefined &&
          event.text.trim() !== ''
        ) {
          finalMessage = event.text;
        }
      } else if (event.type === 'result') {
        status = event.status;
        sessionId = event.sessionId;
        error = event.error;
      }
    }
  } catch (cause) {
    thrown = cause;
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
    sessionId,
    error,
  });

  return { id, finalMessage, cause: thrown };
};
