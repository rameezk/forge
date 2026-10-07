import {
  errorMessage,
  startHeartbeat,
  type ExceededLimit,
  type HarnessEvent,
  type ListPrice,
  type MessageEvent,
  type RunStatus,
  type RunCounters,
  type RunTicket,
  type Store,
  type TokenUsage,
  countEvent,
  noCounters,
  SkillLoadTracker,
} from '@forge/shared';
import {
  invocationFor,
  type Harness,
  type Worker,
  type Workspace,
} from './harness.ts';
import { FingerprintRecorder, skillsHash } from './fingerprint.ts';
import type { OpenAgentDir } from './agent-dir.ts';
import type { LookUpModel } from './openrouter.ts';
import {
  transcriptPolicy,
  type JsonLinesWriter,
  type TranscriptWriter,
} from './transcript.ts';

export interface RunWorkloadOptions {
  store: Store;
  harness: Harness;
  worker: Worker;
  openTranscript: (runId: string) => TranscriptWriter;
  openRawEvents: (runId: string) => JsonLinesWriter;
  openRequestRecord: (runId: string) => JsonLinesWriter;
  openWorkspace: (runId: string) => Workspace | Promise<Workspace>;
  now: () => string;
  newId: () => string;
  lookUpModel: LookUpModel;
  openAgentDir: OpenAgentDir;
  secrets?: string[];
  ticket?: RunTicket;
  forgeGitSha?: string | null;
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

const estimatedCost = (price: ListPrice | null, usage: TokenUsage): number | null => {
  if (price === null) return null;
  let cost = 0;
  for (const [tokens, perToken] of [
    [usage.inputTokens, price.input],
    [usage.outputTokens, price.output],
    [usage.cacheReadTokens, price.cacheRead],
    [usage.cacheWriteTokens, price.cacheWrite],
  ] as const) {
    if (tokens === 0) continue;
    if (perToken === null) return null;
    cost += tokens * perToken;
  }
  return Number.isFinite(cost) ? cost : null;
};

export const runWorkload = async (
  options: RunWorkloadOptions,
): Promise<WorkloadResult> => {
  const { store, harness, worker, openTranscript, openWorkspace, now, newId } =
    options;
  const policy = transcriptPolicy(options.secrets ?? []);
  const id = newId();
  const startTime = now();
  const outcome = await options.lookUpModel(worker.model);
  const listed = 'model' in outcome ? outcome.model : null;
  if ('reason' in outcome) {
    process.stderr.write(
      `run ${id}: could not look up OpenRouter's models entry for ${worker.model} (${outcome.reason}), so its unbilled generations show no estimated cost and pi starts without knowing the model\n`,
    );
  } else if (outcome.model.contextWindow === null) {
    process.stderr.write(
      `run ${id}: OpenRouter lists no context window for ${worker.model}, so pi starts without knowing the model\n`,
    );
  }
  const listPrice = listed?.price ?? null;
  const agentDir = options.openAgentDir(id, worker.model, listed);
  const transcript = openTranscript(id);
  const rawEvents = options.openRawEvents(id);
  const requestRecord = options.openRequestRecord(id);

  store.insertRun({
    id,
    worker: worker.name,
    harness: worker.harness,
    model: worker.model,
    reasoningEffort: worker.reasoningEffort ?? null,
    startTime,
    endTime: null,
    status: 'running',
    costStatus: 'pending',
    costUsd: 0,
    costEstimated: false,
    listPrice,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    transcriptRef: transcript.ref,
    sessionId: null,
    error: null,
    ticket: options.ticket ?? null,
    aliveAt: null,
    harnessStartTime: null,
    timeoutSeconds: worker.timeoutSeconds ?? null,
    maxCostUsd: worker.maxCostUsd ?? null,
    exceededLimit: null,
    counters: null,
  });
  const stopHeartbeat = startHeartbeat(
    () => store.touchRun(id, now()),
    (error) =>
      process.stderr.write(
        `run ${id}: could not refresh its heartbeat: ${errorMessage(error)}\n`,
      ),
  );

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
      estimatedCostUsd: estimatedCost(listPrice, event.usage),
      createdAt: now(),
    });
  };

  let skillLoads: SkillLoadTracker | null = null;
  const recordSkillLoad = (event: HarnessEvent): void => {
    const load = skillLoads?.observe(event) ?? null;
    if (load !== null) {
      store.recordSkillLoad({ ...load, runId: id, loadedAt: now() });
    }
  };

  let status: RunStatus = 'error';
  let sessionId: string | null = null;
  let error: string | null = 'harness stream ended without a result';
  let finalMessage: string | null = null;
  let thrown: unknown = null;
  let fingerprint: FingerprintRecorder | null = null;
  let exceeded: ExceededLimit | null = null;
  const counters: RunCounters = noCounters();
  const stop = new AbortController();
  let stopTimeout = (): void => {};

  try {
    if (worker.maxCostUsd != null && 'reason' in outcome) {
      throw new Error(
        `worker ${worker.name} has a budget of ${worker.maxCostUsd} USD but ${worker.model} could not be priced (${outcome.reason}), so the workload was refused before it started`,
      );
    }
    const promptEvent = policy.record({
      type: 'message',
      role: 'user',
      text: worker.prompt,
      timestamp: startTime,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      generationId: null,
    });
    await transcript.append(promptEvent);
    const workspace = await openWorkspace(id);
    skillLoads =
      workspace.checkout === undefined
        ? null
        : new SkillLoadTracker(workspace.checkout);
    recordSkillLoad(promptEvent);
    const invocation = invocationFor(worker, workspace, agentDir);
    const recorder = new FingerprintRecorder({
      worker,
      identity: await harness.identity(agentDir),
      workDir: invocation.workDir,
      skills: skillsHash(invocation.checkout),
      baseCommit: invocation.baseCommit ?? null,
      forgeGitSha: options.forgeGitSha ?? null,
      record: (recorded) => store.recordFingerprint(id, recorded),
    });
    fingerprint = recorder;
    const sinks = {
      stop: stop.signal,
      rawEvent: (event: unknown): void => {
        rawEvents.append(policy.redactValue(event));
      },
      requestRecord: (line: unknown): void => {
        recorder.observe(line);
        requestRecord.append(policy.redactValue(line));
      },
    };
    store.markHarnessStarted(id, now());
    if (worker.timeoutSeconds != null) {
      const timer = setTimeout(() => {
        exceeded = 'timeout';
        stop.abort();
      }, worker.timeoutSeconds * 1000);
      stopTimeout = () => clearTimeout(timer);
    }
    for await (const harnessEvent of harness.run(invocation, sinks)) {
      const event = policy.record(harnessEvent);
      await transcript.append(event);
      countEvent(counters, event);
      recordSkillLoad(harnessEvent);
      if (event.type === 'message') {
        if (isBillable(event)) {
          recordGeneration(event);
          if (exceeded === null && worker.maxCostUsd != null) {
            const spend = store.workloadSpend(id);
            if (spend.unpriced || spend.costUsd > worker.maxCostUsd) {
              exceeded = 'budget';
              stop.abort();
              break;
            }
          }
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
    fingerprint?.finish();
    stopTimeout();
    stopHeartbeat();
    await transcript.close();
    rawEvents.close();
    requestRecord.close();
  }

  if (exceeded !== null) {
    status = 'exceeded';
    error = `the workload was stopped after its ${exceeded} was exceeded`;
  }

  store.finalizeRun(id, {
    endTime: now(),
    status,
    sessionId,
    error,
    counters,
    ...(exceeded === null ? {} : { exceededLimit: exceeded }),
  });

  return { id, finalMessage, cause: thrown };
};
