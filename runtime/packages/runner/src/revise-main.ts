import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  errorMessage,
  githubAppFromEnv,
  queryFeedbackWindow,
  queryPullRequestHead,
  queryUnansweredFeedback,
  startHeartbeat,
  Store,
  type Fetch,
  type RunRecord,
  type RevisionFailureRecord,
  type RevisionStart,
} from '@forge/shared';
import {
  maxConcurrentOf,
  repositoryTriggeredBy,
  resolveWorker,
} from './config.ts';
import { launchInCheckout } from './checkout-workload.ts';
import { fillPrompt, headRefusal, stateOf } from './pull-request-workload.ts';
import { gitEnvironment } from './git.ts';
import { revisionInstruction, type Worker } from './harness.ts';
import { providerSpec } from './provider.ts';
import { readRuntimeConfig, stateDirOf, type LaunchResult } from './workload.ts';

const now = (): string => new Date().toISOString();

const USAGE = 'usage: forge-revise <repository> <pull-request>';

const startRefusal = (start: Exclude<RevisionStart, { started: number }>): string => {
  switch (start.refused) {
    case 'revising':
      return 'a revision of it is already running';
    case 'dispatching':
      return 'the dispatch that opened it is still running';
    case 'resolving':
      return 'a conflict resolution of it is already running';
    case 'full':
      return `${start.live} ${start.live === 1 ? 'workload is' : 'workloads are'} already running, the most forge.runtime.dispatch.maxConcurrent allows`;
  }
};

const notStartedRun = (
  worker: Worker,
  id: string,
  at: string,
  error: string,
): RunRecord => ({
  id,
  worker: worker.name,
  harness: worker.harness,
  model: worker.model,
  reasoningEffort: worker.reasoningEffort ?? null,
  startTime: at,
  endTime: at,
  status: 'error',
  costStatus: providerSpec(worker.provider).subscription ? 'subscription' : 'pending',
  costUsd: 0,
  costEstimated: false,
  listPrice: null,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  transcriptRef: null,
  sessionId: null,
  error,
  ticket: null,
  aliveAt: null,
  harnessStartTime: null,
  timeoutSeconds: worker.timeoutSeconds ?? null,
  maxCostUsd: worker.maxCostUsd ?? null,
  exceededLimit: null,
  counters: null,
});

export const main = async (
  argv: string[],
  env: NodeJS.ProcessEnv,
  fetch: Fetch,
): Promise<number> => {
  const [name, number, ...rest] = argv;
  if (
    name === undefined ||
    number === undefined ||
    rest.length > 0 ||
    !/^[1-9][0-9]*$/.test(number)
  ) {
    throw new Error(USAGE);
  }
  const config = readRuntimeConfig(env);
  const repository = repositoryTriggeredBy(config.repositories, name, 'feedback');
  const worker = resolveWorker(config, repository.worker);
  const app = githubAppFromEnv(env, fetch);

  const store = Store.open(join(stateDirOf(env), 'forge.db'));
  try {
    let prepared;
    try {
      const identity = await app.identity(repository.github);
      const token = (await app.mint(repository.github, 'write')).token;
      prepared = {
        identity,
        gitEnv: gitEnvironment(env, identity),
        token,
        pullRequest: await queryPullRequestHead(fetch, token, repository.github, Number(number)),
      };
    } catch (error) {
      const at = now();
      store.recordFailedRevision(
        {
          repository: name,
          number: Number(number),
          url: `https://github.com/${repository.github}/pull/${number}`,
        },
        notStartedRun(worker, randomUUID(), at, errorMessage(error)),
      );
      throw error;
    }
    const { identity, gitEnv, token, pullRequest } = prepared;
    const refused = headRefusal(pullRequest);
    if (refused !== null) {
      console.error(`${name}#${pullRequest.number} cannot be revised: ${refused}`);
      return 1;
    }

    const revised = { repository: name, number: pullRequest.number, url: pullRequest.url };
    const runId = randomUUID();
    const startedAt = now();
    const start = store.startRevision(
      revised,
      pullRequest.closes,
      runId,
      startedAt,
      maxConcurrentOf(config),
    );
    if ('refused' in start) {
      console.error(`${name}#${pullRequest.number} cannot be revised: ${startRefusal(start)}`);
      return 1;
    }
    const revisionId = start.started;
    const { after } = start;
    const stopHeartbeat = startHeartbeat(
      () => store.touchRevision(revisionId, now()),
      (error) =>
        console.error(
          `${name}#${pullRequest.number}: could not refresh its revision heartbeat: ${errorMessage(error)}`,
        ),
    );
    try {
      let launched: LaunchResult;
      let failure: RevisionFailureRecord | undefined;
      try {
        const feedback = await queryFeedbackWindow(
          fetch,
          token,
          repository.github,
          pullRequest.number,
          after,
          startedAt,
        );
        if (feedback.length === 0) {
          store.endRevision(revisionId, 'ok', now());
          return 0;
        }
        launched = await launchInCheckout({
          env,
          config,
          worker: {
            ...worker,
            prompt: fillPrompt(worker.prompt, repository.github, pullRequest),
            promptTemplate: worker.prompt,
          },
          github: repository.github,
          branch: pullRequest.branch,
          instruction: revisionInstruction(feedback),
          app,
          gitEnv,
          identity,
          runId,
        });
        if (stateOf(launched) === 'ok') {
          const unanswered = await queryUnansweredFeedback(
            fetch,
            (await app.mint(repository.github, 'read')).token,
            repository.github,
            pullRequest.number,
            identity.name,
            feedback,
          );
          if (unanswered.length > 0) {
            failure = { reason: 'unanswered', detail: unanswered.map(({ url }) => url).join('\n') };
          }
        }
      } catch (error) {
        store.endRevision(revisionId, 'error', now(), {
          reason: 'crashed',
          detail: errorMessage(error),
        });
        throw error;
      }
      store.endRevision(
        revisionId,
        failure === undefined ? stateOf(launched) : 'error',
        now(),
        failure,
      );
      return failure !== undefined || launched.run.status === 'error' || launched.run.status === 'exceeded'
        ? 1
        : 0;
    } finally {
      stopHeartbeat();
    }
  } finally {
    store.close();
  }
};

if (import.meta.filename === process.argv[1]) {
  main(process.argv.slice(2), process.env, globalThis.fetch)
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(errorMessage(error));
      process.exit(1);
    });
}
