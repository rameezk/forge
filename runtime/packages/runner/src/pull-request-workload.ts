import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  errorMessage,
  githubAppFromEnv,
  queryPullRequestHead,
  startHeartbeat,
  Store,
  type BotIdentity,
  type ConflictResolutionFailureRecord,
  type FeedbackItem,
  type Fetch,
  type GithubApp,
  type PullRequestHead,
  type PullRequestConflict,
  type RevisedPullRequest,
  type RevisionFailureRecord,
  type RevisionStart,
  type RevisionState,
} from '@forge/shared';
import { launchInCheckout } from './checkout-workload.ts';
import {
  maxConcurrentOf,
  repositoryTriggeredBy,
  resolveWorker,
  type RuntimeConfig,
} from './config.ts';
import { gitEnvironment } from './git.ts';
import { withContext } from './harness.ts';
import { SetupTimedOut } from './setup.ts';
import { readRuntimeConfig, stateDirOf, type LaunchResult } from './workload.ts';

const now = (): string => new Date().toISOString();

interface Shapes {
  feedback: {
    target: null;
    carried: readonly FeedbackItem[];
    failure: RevisionFailureRecord;
  };
  conflict: {
    target: PullRequestConflict;
    carried: null;
    failure: ConflictResolutionFailureRecord;
  };
}

type Trigger = keyof Shapes;

interface Reads {
  env: NodeJS.ProcessEnv;
  fetch: Fetch;
  config: RuntimeConfig;
  app: GithubApp;
  github: string;
  pullRequest: PullRequestHead;
  token: string;
  identity: BotIdentity;
  gitEnv: Record<string, string>;
  runId: string;
}

interface Started {
  startedAt: string;
  after: string | null;
}

export interface PullRequestKind<K extends Trigger> {
  command: string;
  trigger: K;
  refusal: string;
  noun: string;
  launch: { instruction: string; conflictResolution: boolean };
  prepare: (reads: Reads) => Promise<Shapes[K]['target']>;
  before: (
    reads: Reads,
    target: Shapes[K]['target'],
    started: Started,
  ) => Promise<{ context: string; carried: Shapes[K]['carried'] } | null>;
  after: (
    reads: Reads,
    target: Shapes[K]['target'],
    carried: Shapes[K]['carried'],
  ) => Promise<Shapes[K]['failure'] | undefined>;
}

type SharedFailure = {
  reason: 'crashed' | 'errored' | 'interrupted' | 'exceeded';
  detail: string | null;
};

type Refusal = Exclude<RevisionStart, { started: number }>;

interface StoreCalls<Shape extends Shapes[Trigger]> {
  recordStartFailure: (
    store: Store,
    pullRequest: RevisedPullRequest,
    detail: string,
    at: string,
  ) => void;
  start: (
    store: Store,
    pullRequest: RevisedPullRequest,
    openedBy: readonly number[],
    runId: string,
    at: string,
    maxConcurrent: number,
    target: Shape['target'],
  ) => { started: number; after: string | null } | Refusal;
  touch: (store: Store, id: number, at: string) => void;
  recordPush: (store: Store, id: number, headSha: string) => void;
  failStart: (store: Store, id: number, detail: string, at: string) => void;
  end: (
    store: Store,
    id: number,
    state: Exclude<RevisionState, 'running'>,
    at: string,
    failure?: SharedFailure | Shape['failure'],
  ) => void;
}

const STORE: { [K in Trigger]: StoreCalls<Shapes[K]> } = {
  feedback: {
    recordStartFailure: (store, pullRequest, detail, at) =>
      store.recordRevisionStartFailure(pullRequest, detail, at),
    start: (store, pullRequest, openedBy, runId, at, maxConcurrent) =>
      store.startRevision(pullRequest, openedBy, runId, at, maxConcurrent),
    touch: (store, id, at) => store.touchRevision(id, at),
    recordPush: (store, id, headSha) => store.recordRevisionPush(id, headSha),
    failStart: (store, id, detail, at) => store.failRevisionStart(id, detail, at),
    end: (store, id, state, at, failure) => store.endRevision(id, state, at, failure),
  },
  conflict: {
    recordStartFailure: (store, pullRequest, detail, at) =>
      store.recordConflictResolutionStartFailure(pullRequest, detail, at),
    start: (store, pullRequest, openedBy, runId, at, maxConcurrent, target) => {
      const start = store.startConflictResolution(pullRequest, openedBy, runId, at, maxConcurrent, {
        headSha: target.headSha,
        defaultSha: target.defaultSha,
      });
      return 'started' in start ? { started: start.started, after: null } : start;
    },
    touch: (store, id, at) => store.touchConflictResolution(id, at),
    recordPush: (store, id, headSha) => store.recordConflictResolutionPush(id, headSha),
    failStart: (store, id, detail, at) => store.failConflictResolutionStart(id, detail, at),
    end: (store, id, state, at, failure) => store.endConflictResolution(id, state, at, failure),
  },
};

const fillPrompt = (template: string, github: string, pullRequest: PullRequestHead): string =>
  template
    .replaceAll('{repo}', github)
    .replaceAll('{pr}', String(pullRequest.number))
    .replaceAll('{url}', pullRequest.url)
    .replaceAll('{branch}', pullRequest.branch);

const headRefusal = (pullRequest: PullRequestHead): string | null => {
  if (!pullRequest.open) return 'it is not open';
  if (pullRequest.fromFork) return 'its branch is on a fork';
  return null;
};

const startRefusal = (refusal: Refusal): string => {
  switch (refusal.refused) {
    case 'revising':
      return 'a revision of it is already running';
    case 'dispatching':
      return 'the dispatch that opened it is still running';
    case 'resolving':
      return 'a conflict resolution of it is already running';
    case 'full':
      return `${refusal.live} ${refusal.live === 1 ? 'workload is' : 'workloads are'} already running, the most forge.runtime.dispatch.maxConcurrent allows`;
  }
};

interface WorkloadEnd {
  state: Exclude<RevisionState, 'running'>;
  failure?: SharedFailure;
}

const endOf = ({ run }: LaunchResult): WorkloadEnd => {
  if (run.status === 'success') return { state: 'done' };
  if (run.status === 'exceeded') {
    return { state: 'failed', failure: { reason: 'exceeded', detail: run.exceededLimit } };
  }
  if (run.status === 'interrupted') {
    return { state: 'failed', failure: { reason: 'interrupted', detail: null } };
  }
  return { state: 'failed' };
};

const USAGE_ARGUMENTS = '<repository> <pull-request>';

export const runPullRequestWorkload = async <K extends Trigger>(
  kind: PullRequestKind<K>,
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
    throw new Error(`usage: ${kind.command} ${USAGE_ARGUMENTS}`);
  }
  const config = readRuntimeConfig(env);
  const repository = repositoryTriggeredBy(config.repositories, name, kind.trigger);
  const worker = resolveWorker(config, repository.worker);
  const app = githubAppFromEnv(env, fetch);
  const table = STORE[kind.trigger];
  const { github } = repository;

  const store = Store.open(join(stateDirOf(env), 'forge.db'));
  try {
    const runId = randomUUID();
    let prepared;
    try {
      const identity = await app.identity(github);
      const token = (await app.mint(github, 'write')).token;
      const pullRequest = await queryPullRequestHead(fetch, token, github, Number(number));
      const refused = headRefusal(pullRequest);
      if (refused !== null) {
        prepared = { refused };
      } else {
        const reads: Reads = {
          env,
          fetch,
          config,
          app,
          github,
          pullRequest,
          token,
          identity,
          gitEnv: gitEnvironment(env, identity, {
            conflictResolution: kind.launch.conflictResolution,
          }),
          runId,
        };
        prepared = { refused, reads, target: await kind.prepare(reads) };
      }
    } catch (error) {
      table.recordStartFailure(
        store,
        {
          repository: name,
          number: Number(number),
          url: `https://github.com/${github}/pull/${number}`,
        },
        errorMessage(error),
        now(),
      );
      throw error;
    }
    if (prepared.refused !== null) {
      console.error(`${name}#${number} ${kind.refusal}: ${prepared.refused}`);
      return 1;
    }
    const { reads, target } = prepared;
    const { pullRequest, identity, gitEnv } = reads;

    const subject = { repository: name, number: pullRequest.number, url: pullRequest.url };
    const startedAt = now();
    const start = table.start(
      store,
      subject,
      pullRequest.closes,
      runId,
      startedAt,
      maxConcurrentOf(config),
      target,
    );
    if ('refused' in start) {
      console.error(`${name}#${pullRequest.number} ${kind.refusal}: ${startRefusal(start)}`);
      return 1;
    }
    const id = start.started;
    const stopHeartbeat = startHeartbeat(
      () => table.touch(store, id, now()),
      (error) =>
        console.error(
          `${name}#${pullRequest.number}: could not refresh its ${kind.noun} heartbeat: ${errorMessage(error)}`,
        ),
    );
    const recordPush = async (): Promise<void> => {
      try {
        const { headSha } = await queryPullRequestHead(
          fetch,
          (await app.mint(github, 'read')).token,
          github,
          pullRequest.number,
        );
        if (headSha !== pullRequest.headSha) table.recordPush(store, id, headSha);
      } catch (error) {
        console.error(
          `${name}#${pullRequest.number}: could not record the head its ${kind.noun} pushed: ${errorMessage(error)}`,
        );
      }
    };
    try {
      let ended: WorkloadEnd = { state: 'done' };
      let failure: Shapes[K]['failure'] | undefined;
      try {
        const work = await kind.before(reads, target, { startedAt, after: start.after });
        if (work === null) {
          table.end(store, id, 'done', now());
          return 0;
        }
        const launched = await launchInCheckout({
          env,
          config,
          worker: {
            ...worker,
            prompt: withContext(fillPrompt(worker.prompt, github, pullRequest), work.context),
            promptTemplate: worker.prompt,
          },
          github,
          workflows: repository.workflows,
          branch: pullRequest.branch,
          instruction: kind.launch.instruction,
          app,
          gitEnv,
          identity,
          runId,
          fetch,
          pullRequest: async () => pullRequest.number,
          conflictResolution: kind.launch.conflictResolution,
        });
        if (launched.run.harnessStartTime == null && launched.cause instanceof SetupTimedOut) {
          table.end(store, id, 'failed', now(), {
            reason: 'errored',
            detail: launched.run.error,
          });
          return 1;
        }
        if (launched.run.harnessStartTime == null) {
          table.failStart(store, id, launched.run.error ?? errorMessage(launched.cause), now());
          return 1;
        }
        ended = endOf(launched);
        await recordPush();
        if (ended.state === 'done') failure = await kind.after(reads, target, work.carried);
      } catch (error) {
        if (error instanceof SetupTimedOut) {
          table.end(store, id, 'failed', now(), { reason: 'errored', detail: error.message });
        } else if (store.runs.getRun(runId)?.harnessStartTime == null) {
          table.failStart(store, id, errorMessage(error), now());
        } else {
          table.end(store, id, 'failed', now(), { reason: 'crashed', detail: errorMessage(error) });
        }
        throw error;
      }
      const final: WorkloadEnd | { state: 'failed'; failure: Shapes[K]['failure'] } =
        failure === undefined ? ended : { state: 'failed', failure };
      table.end(store, id, final.state, now(), final.failure);
      return final.state === 'done' ? 0 : 1;
    } finally {
      stopHeartbeat();
    }
  } finally {
    store.close();
  }
};
