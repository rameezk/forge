import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type ConflictResolutionState } from '@forge/shared';
import { main as sync } from '../../frontier/src/main.ts';
import { main as pass } from '../src/pass-main.ts';
import {
  APP_ID,
  APP_SLUG,
  fakeGithubApp,
  routedThrough,
} from '../../shared/test/fixtures/fake-github-app.ts';
import { journaled, startedDispatch } from './helpers.ts';

const MINUTE = 60_000;

const ago = (minutes: number): string => new Date(Date.now() - minutes * MINUTE).toISOString();

type Mergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';

interface FakePullRequest {
  number: number;
  authoredByForge: boolean;
  mergeable: Mergeable;
  headSha: string;
  closes: number[];
  feedbackAt: string | null;
}

const pullRequest = (number: number, overrides: Partial<FakePullRequest> = {}): FakePullRequest => ({
  number,
  authoredByForge: true,
  mergeable: 'CONFLICTING',
  headSha: `head-${number}-a`,
  closes: [],
  feedbackAt: null,
  ...overrides,
});

const graphqlNode = (pull: FakePullRequest) => ({
  number: pull.number,
  url: `https://github.com/rameezk/forge/pull/${pull.number}`,
  author: pull.authoredByForge
    ? { __typename: 'Bot', login: APP_SLUG }
    : { __typename: 'User', login: 'someone' },
  mergeable: pull.mergeable,
  headRefOid: pull.headSha,
  closingIssuesReferences: {
    nodes: pull.closes.map((number) => ({ number, repository: { nameWithOwner: 'rameezk/forge' } })),
  },
  reviews: {
    nodes:
      pull.feedbackAt === null
        ? []
        : [
            {
              author: { __typename: 'User', login: 'reviewer' },
              body: 'Please rename this',
              submittedAt: pull.feedbackAt,
              comments: { totalCount: 1 },
            },
          ],
  },
  comments: { nodes: [] },
});

interface Setup {
  maxConcurrent?: number;
  conflictWorker?: boolean;
  feedbackWorker?: boolean;
}

const forge = ({ maxConcurrent, conflictWorker = true, feedbackWorker = true }: Setup = {}) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'forge-conflict-trigger-'));
  const configPath = join(stateDir, 'runtime.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      harnesses: { pi: { command: '/bin/false' } },
      workers: {
        resolver: { harness: 'pi', model: 'z-ai/glm-5', prompt: '/resolve {url}' },
        reviser: { harness: 'pi', model: 'z-ai/glm-5', prompt: '/revise {url}' },
      },
      repositories: {
        forge: {
          github: 'rameezk/forge',
          on: {
            ...(conflictWorker ? { conflict: 'resolver' } : {}),
            ...(feedbackWorker ? { feedback: 'reviser' } : {}),
          },
        },
      },
      ...(maxConcurrent === undefined ? {} : { dispatch: { maxConcurrent } }),
    }),
  );
  const app = fakeGithubApp(['rameezk/forge']);
  const keyPath = join(stateDir, 'github-app-private-key');
  writeFileSync(keyPath, app.privateKey);
  const record = join(stateDir, 'systemctl-calls');
  const systemctl = join(stateDir, 'systemctl');
  writeFileSync(systemctl, `#!/bin/sh\necho "$*" >> "${record}"\n`);
  chmodSync(systemctl, 0o755);
  const env = {
    FORGE_RUNTIME_CONFIG: configPath,
    FORGE_STATE_DIR: stateDir,
    FORGE_GITHUB_APP_ID: APP_ID,
    FORGE_GITHUB_APP_PRIVATE_KEY_FILE: keyPath,
    FORGE_SYSTEMCTL: systemctl,
  };

  const world = { defaultSha: 'default-a' };

  const github =
    (pulls: () => FakePullRequest[]): typeof globalThis.fetch =>
    async (input, init) => {
      if (/\/collaborators\/reviewer\/permission$/.test(new URL(String(input)).pathname)) {
        return new Response(JSON.stringify({ permission: 'write' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      const body = JSON.parse(String(init?.body)) as { query: string };
      const operation = /query (\w+)/.exec(body.query)?.[1];
      const empty = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
      const data =
        operation === 'Frontier' || operation === 'ClosedTickets' || operation === 'LabelledIssues'
          ? { repository: { issues: empty } }
          : operation === 'WatchedPullRequests'
            ? {
                repository: {
                  defaultBranchRef: { name: 'main', target: { oid: world.defaultSha } },
                  pullRequests: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: pulls().map(graphqlNode),
                  },
                },
              }
            : operation === 'PullRequest'
              ? { repository: { pullRequest: { state: 'OPEN', mergedAt: null, closedAt: null, commits: empty } } }
              : undefined;
      if (data === undefined) throw new Error(`unexpected GitHub request ${String(operation)}`);
      return new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } });
    };

  const started = (): string[] =>
    existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n') : [];

  const withStore = <T>(use: (store: Store) => T): T => {
    const store = Store.open(join(stateDir, 'forge.db'));
    try {
      return use(store);
    } finally {
      store.close();
    }
  };

  const syncAndPass = async (pulls: FakePullRequest[]): Promise<string[]> => {
    const before = started().length;
    const synced = await journaled(() => sync(['sync'], env, routedThrough(app, github(() => pulls))));
    assert.equal(synced.result, 0, synced.journal);
    const passed = await journaled(() => pass([], env));
    assert.equal(passed.result, 0, passed.journal);
    return started().slice(before);
  };

  const resolve = (
    number: number,
    pair: { headSha: string; defaultSha: string },
    state: Exclude<ConflictResolutionState, 'running'> | 'running' | 'not-started' = 'error',
  ): number =>
    withStore((store) => {
      const start = store.startConflictResolution(
        { repository: 'forge', number, url: `https://github.com/rameezk/forge/pull/${number}` },
        [],
        randomUUID(),
        new Date().toISOString(),
        Number.POSITIVE_INFINITY,
        pair,
      );
      assert.ok('started' in start);
      if (state === 'not-started') {
        store.failConflictResolutionStart(start.started, 'clone failed', new Date().toISOString());
      } else if (state !== 'running') {
        store.endConflictResolution(
          start.started,
          state,
          new Date().toISOString(),
          state === 'ok' ? undefined : { reason: 'crashed', detail: null },
        );
      }
      return start.started;
    });

  return { world, withStore, syncAndPass, resolve };
};

const unit = (number: number): string =>
  `start --no-block --no-ask-password -- forge-resolve-conflicts@forge:${number}.service`;

test('given a repository declaring on.conflict and an open forge pull request GitHub reports as conflicting, when the frontier syncs and the pass runs, then a conflict resolution starts for it', async () => {
  const setup = forge();
  assert.deepEqual(await setup.syncAndPass([pullRequest(143)]), [unit(143)]);
});

test('given pull requests that are mergeable, behind but mergeable, or not yet computed, when sync and the pass run, then no conflict resolution starts, and once GitHub computes a conflict the next sync starts one', async () => {
  const setup = forge();
  assert.deepEqual(
    await setup.syncAndPass([
      pullRequest(143, { mergeable: 'MERGEABLE' }),
      pullRequest(144, { mergeable: 'MERGEABLE', headSha: 'behind-the-default-branch' }),
      pullRequest(145, { mergeable: 'UNKNOWN' }),
    ]),
    [],
  );
  assert.deepEqual(
    await setup.syncAndPass([
      pullRequest(143, { mergeable: 'MERGEABLE' }),
      pullRequest(144, { mergeable: 'MERGEABLE', headSha: 'behind-the-default-branch' }),
      pullRequest(145, { mergeable: 'CONFLICTING' }),
    ]),
    [unit(145)],
  );
});

test('given a conflicting forge pull request in a repository without on.conflict, when sync and the pass run, then no conflict resolution starts', async () => {
  const setup = forge({ conflictWorker: false });
  assert.deepEqual(await setup.syncAndPass([pullRequest(143)]), []);
});

test('given a conflicting open pull request authored by a person, when sync and the pass run, then no conflict resolution starts', async () => {
  const setup = forge();
  assert.deepEqual(await setup.syncAndPass([pullRequest(143, { authoredByForge: false })]), []);
});

test('given a conflicting pull request whose opening dispatch is running, when the pass runs, then no conflict resolution starts until the dispatch ends', async () => {
  const setup = forge();
  const pulls = [pullRequest(143, { closes: [113] })];
  const dispatch = setup.withStore((store) =>
    startedDispatch(store, 'forge', 113, 'run-dispatch', new Date().toISOString()),
  );
  assert.deepEqual(await setup.syncAndPass(pulls), []);

  setup.withStore((store) =>
    store.endDispatch(
      dispatch,
      { state: 'done', pullRequest: { number: 143, url: 'https://github.com/rameezk/forge/pull/143' } },
      new Date().toISOString(),
    ),
  );
  assert.deepEqual(await setup.syncAndPass(pulls), [unit(143)]);
});

test('given a conflicting pull request with a running revision, when the pass runs, then no conflict resolution starts until the revision ends', async () => {
  const setup = forge({ maxConcurrent: 5 });
  const pulls = [pullRequest(143)];
  const running = setup.withStore((store) => {
    const start = store.startRevision(
      { repository: 'forge', number: 143, url: 'https://github.com/rameezk/forge/pull/143' },
      [],
      'run-revision',
      new Date().toISOString(),
      5,
    );
    assert.ok('started' in start);
    return start.started;
  });
  assert.deepEqual(await setup.syncAndPass(pulls), []);

  setup.withStore((store) => store.endRevision(running, 'ok', new Date().toISOString()));
  assert.deepEqual(await setup.syncAndPass(pulls), [unit(143)]);
});

test('given a conflicting pull request with a running conflict resolution for an older pair, when the pass runs, then no conflict resolution starts until it ends', async () => {
  const setup = forge({ maxConcurrent: 5 });
  const running = setup.resolve(143, { headSha: 'head-143-old', defaultSha: 'default-a' }, 'running');
  assert.deepEqual(await setup.syncAndPass([pullRequest(143)]), []);

  setup.withStore((store) => store.endConflictResolution(running, 'ok', new Date().toISOString()));
  assert.deepEqual(await setup.syncAndPass([pullRequest(143)]), [unit(143)]);
});

test('given a conflicting pull request that also has feedback past its quiet period, when the pass runs, then the conflict resolution starts and the revision does not', async () => {
  const setup = forge({ maxConcurrent: 5 });
  assert.deepEqual(await setup.syncAndPass([pullRequest(143, { feedbackAt: ago(60) })]), [unit(143)]);
});

test('given more due conflict resolutions and revisions than free slots, when the pass runs, then no more units start than there are free slots and conflict resolutions take them first', async () => {
  const setup = forge({ maxConcurrent: 2 });
  assert.deepEqual(
    await setup.syncAndPass([
      pullRequest(145, { mergeable: 'MERGEABLE', feedbackAt: ago(60) }),
      pullRequest(143),
      pullRequest(144),
    ]),
    [unit(143), unit(144)],
  );
});

test('given a live workload already holding one of two slots, when two conflict resolutions are due, then only one starts', async () => {
  const setup = forge({ maxConcurrent: 2 });
  setup.withStore((store) => startedDispatch(store, 'forge', 7, 'run-dispatch', new Date().toISOString()));
  assert.equal((await setup.syncAndPass([pullRequest(143), pullRequest(144)])).length, 1);
});

test('given a conflict resolution that ended, ok or not, for a pull request\'s current head and default shas, when sync and the pass run again, then none starts', async () => {
  const setup = forge();
  const pulls = [pullRequest(143)];
  setup.resolve(143, { headSha: 'head-143-a', defaultSha: 'default-a' }, 'error');
  assert.deepEqual(await setup.syncAndPass(pulls), []);
  assert.deepEqual(await setup.syncAndPass(pulls), []);

  const ok = forge();
  ok.resolve(143, { headSha: 'head-143-a', defaultSha: 'default-a' }, 'ok');
  assert.deepEqual(await ok.syncAndPass(pulls), []);
});

test('given a failed conflict resolution for a sha pair, when the pull request\'s branch gains a commit and it still conflicts, then a new one starts', async () => {
  const setup = forge();
  setup.resolve(143, { headSha: 'head-143-a', defaultSha: 'default-a' }, 'error');
  assert.deepEqual(await setup.syncAndPass([pullRequest(143, { headSha: 'head-143-b' })]), [unit(143)]);
});

test('given a failed conflict resolution for a sha pair, when the default branch gains a commit and the pull request still conflicts, then a new one starts', async () => {
  const setup = forge();
  setup.resolve(143, { headSha: 'head-143-a', defaultSha: 'default-a' }, 'error');
  setup.world.defaultSha = 'default-b';
  assert.deepEqual(await setup.syncAndPass([pullRequest(143)]), [unit(143)]);
});

test('given a conflict resolution whose latest record is a failed start for the current head and default shas, when sync and the pass run again, then a new one starts without either branch moving', async () => {
  const setup = forge();
  setup.resolve(143, { headSha: 'head-143-a', defaultSha: 'default-a' }, 'not-started');
  assert.deepEqual(await setup.syncAndPass([pullRequest(143)]), [unit(143)]);
});

test('given a failed start followed by a conflict resolution that ran and failed for the current shas, when sync and the pass run again, then none starts', async () => {
  const setup = forge();
  setup.resolve(143, { headSha: 'head-143-a', defaultSha: 'default-a' }, 'not-started');
  setup.resolve(143, { headSha: 'head-143-a', defaultSha: 'default-a' }, 'error');
  assert.deepEqual(await setup.syncAndPass([pullRequest(143)]), []);
});

test('given a repository declaring on.conflict but not on.feedback, when a forge pull request conflicts, then the sync still watches it and a conflict resolution starts', async () => {
  const setup = forge({ feedbackWorker: false });
  assert.deepEqual(await setup.syncAndPass([pullRequest(143)]), [unit(143)]);
});
