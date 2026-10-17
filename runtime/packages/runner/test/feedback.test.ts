import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '@forge/shared';
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

interface Author {
  login: string;
  type: 'User' | 'Bot';
  association: string;
}

const PERSON: Author = { login: 'reviewer', type: 'User', association: 'COLLABORATOR' };
const OWNER: Author = { login: 'rameezk', type: 'User', association: 'OWNER' };
const MEMBER: Author = { login: 'colleague', type: 'User', association: 'MEMBER' };
const OUTSIDER: Author = { login: 'stranger', type: 'User', association: 'NONE' };
const FORGE: Author = { login: APP_SLUG, type: 'Bot', association: 'NONE' };
const OTHER_BOT: Author = { login: 'dependabot', type: 'Bot', association: 'NONE' };

interface Review {
  author: Author;
  body: string;
  inline: number;
  at: string;
}

interface Comment {
  author: Author;
  at: string;
}

interface FakePullRequest {
  number: number;
  author: Author;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  closes?: number[];
  reviews: Review[];
  comments: Comment[];
}

const review = (at: string, overrides: Partial<Review> = {}): Review => ({
  author: PERSON,
  body: 'Please rename this',
  inline: 1,
  at,
  ...overrides,
});

const comment = (at: string, author: Author = PERSON): Comment => ({ author, at });

const pullRequest = (number: number, overrides: Partial<FakePullRequest> = {}): FakePullRequest => ({
  number,
  author: FORGE,
  state: 'OPEN',
  reviews: [],
  comments: [],
  ...overrides,
});

const actor = ({ login, type }: Author) => ({ __typename: type, login });

const graphqlNode = (pull: FakePullRequest) => ({
  number: pull.number,
  url: `https://github.com/rameezk/forge/pull/${pull.number}`,
  mergeable: 'MERGEABLE',
  headRefOid: `head-${pull.number}`,
  author: actor(pull.author),
  closingIssuesReferences: {
    nodes: (pull.closes ?? []).map((number) => ({
      number,
      repository: { nameWithOwner: 'rameezk/forge' },
    })),
  },
  reviews: {
    nodes: pull.reviews.map((r) => ({
      author: actor(r.author),
      authorAssociation: r.author.association,
      body: r.body,
      submittedAt: r.at,
      comments: { totalCount: r.inline },
    })),
  },
  comments: {
    nodes: pull.comments.map((c) => ({
      author: actor(c.author),
      authorAssociation: c.author.association,
      createdAt: c.at,
    })),
  },
});

const github = (pulls: () => FakePullRequest[]): typeof globalThis.fetch =>
  async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { query: string };
    const operation = /query (\w+)/.exec(body.query)?.[1];
    const data =
      operation === 'Frontier' || operation === 'ClosedTickets' || operation === 'LabelledIssues'
        ? { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } }
        : operation === 'WatchedPullRequests'
          ? {
              repository: {
                defaultBranchRef: { target: { oid: 'default-a' } },
                pullRequests: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: pulls()
                    .filter(({ state }) => state === 'OPEN')
                    .map(graphqlNode),
                },
              },
            }
          : operation === 'PullRequest'
            ? { repository: { pullRequest: { state: 'OPEN', mergedAt: null, closedAt: null, commits: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }
            : undefined;
    if (data === undefined) throw new Error(`unexpected GitHub request ${String(operation)}`);
    return new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } });
  };

interface Setup {
  quietPeriodSeconds?: number;
  maxConcurrent?: number;
  feedbackWorker?: boolean;
}

const forge = ({ quietPeriodSeconds, maxConcurrent, feedbackWorker = true }: Setup = {}) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'forge-feedback-'));
  const configPath = join(stateDir, 'runtime.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      harnesses: { pi: { command: '/bin/false' } },
      workers: {
        reviser: { harness: 'pi', model: 'z-ai/glm-5', prompt: '/revise {url}' },
      },
      repositories: {
        forge: {
          github: 'rameezk/forge',
          on: feedbackWorker ? { feedback: 'reviser' } : {},
        },
      },
      ...(maxConcurrent === undefined ? {} : { dispatch: { maxConcurrent } }),
      ...(quietPeriodSeconds === undefined ? {} : { feedback: { quietPeriodSeconds } }),
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
    const synced = await journaled(() =>
      sync(['sync'], env, routedThrough(app, github(() => pulls))),
    );
    assert.equal(synced.result, 0, synced.journal);
    const passed = await journaled(() => pass([], env));
    assert.equal(passed.result, 0, passed.journal);
    return started().slice(before);
  };

  const revise = (number: number, startedMinutesAgo: number, state: 'ok' | 'error' = 'ok'): void =>
    withStore((store) => {
      const start = store.startRevision(
        { repository: 'forge', number, url: `https://github.com/rameezk/forge/pull/${number}` },
        [],
        randomUUID(),
        ago(startedMinutesAgo),
        Number.POSITIVE_INFINITY,
      );
      assert.ok('started' in start);
      store.endRevision(start.started, state, new Date().toISOString());
    });

  return { stateDir, env, withStore, syncAndPass, revise };
};

const REVISE_UNIT = 'start --no-block --no-ask-password -- forge-revise@forge:143.service';

test('given an open pull request authored by the App and a person\'s review with inline comments, when sync and the pass run before and then after the quiet period has passed since that review, then no revision starts before and exactly one starts after', async () => {
  const before = forge();
  assert.deepEqual(
    await before.syncAndPass([pullRequest(143, { reviews: [review(ago(9))] })]),
    [],
  );

  const after = forge();
  assert.deepEqual(
    await after.syncAndPass([pullRequest(143, { reviews: [review(ago(11))] })]),
    [REVISE_UNIT],
  );
});

test('given a review and then a conversation comment five minutes later, when the quiet period has not passed since the comment, then no revision starts, and once it has exactly one starts', async () => {
  const waiting = forge();
  assert.deepEqual(
    await waiting.syncAndPass([
      pullRequest(143, { reviews: [review(ago(14))], comments: [comment(ago(9))] }),
    ]),
    [],
  );

  const quiet = forge();
  assert.deepEqual(
    await quiet.syncAndPass([
      pullRequest(143, { reviews: [review(ago(16))], comments: [comment(ago(11))] }),
    ]),
    [REVISE_UNIT],
  );
});

test('given a watched pull request with only App replies, a bot review and an approval with no body or inline comments, when sync and the pass run long past the quiet period, then no revision starts', async () => {
  const setup = forge();
  assert.deepEqual(
    await setup.syncAndPass([
      pullRequest(143, {
        reviews: [
          review(ago(60), { author: OTHER_BOT }),
          review(ago(60), { body: '', inline: 0 }),
          review(ago(60), { author: FORGE }),
        ],
        comments: [comment(ago(60), FORGE), comment(ago(60), OTHER_BOT)],
      }),
    ]),
    [],
  );
});

test('given a pull request and an outsider\'s review and comment, when sync and the pass run long past the quiet period, then no revision starts', async () => {
  const setup = forge();
  assert.deepEqual(
    await setup.syncAndPass([
      pullRequest(143, {
        reviews: [review(ago(60), { author: OUTSIDER })],
        comments: [comment(ago(60), OUTSIDER)],
      }),
    ]),
    [],
  );
});

test('given a collaborator\'s comment about to pass its quiet period, when an outsider comments before it does, then a revision starts once the collaborator\'s comment has been quiet for the quiet period', async () => {
  const setup = forge();
  assert.deepEqual(
    await setup.syncAndPass([
      pullRequest(143, { comments: [comment(ago(11)), comment(ago(2), OUTSIDER)] }),
    ]),
    [REVISE_UNIT],
  );
});

test('given a review summary by an organisation member who is not a collaborator, when it has been quiet past the quiet period, then no revision starts', async () => {
  const setup = forge();
  assert.deepEqual(
    await setup.syncAndPass([pullRequest(143, { reviews: [review(ago(60), { author: MEMBER })] })]),
    [],
  );
});

test('given a review summary by the owner or a conversation comment by a collaborator, when it has been quiet past the quiet period, then a revision starts', async () => {
  assert.deepEqual(
    await forge().syncAndPass([pullRequest(143, { reviews: [review(ago(60), { author: OWNER })] })]),
    [REVISE_UNIT],
  );
  assert.deepEqual(
    await forge().syncAndPass([pullRequest(143, { comments: [comment(ago(60))] })]),
    [REVISE_UNIT],
  );
});

test('given an open pull request authored by a person with a person\'s review, when sync and the pass run past the quiet period, then no revision starts', async () => {
  const setup = forge();
  assert.deepEqual(
    await setup.syncAndPass([
      pullRequest(143, { author: PERSON, reviews: [review(ago(60))] }),
    ]),
    [],
  );
});

test('given feedback past its quiet period on a pull request whose opening dispatch is running, when the pass runs, then no revision starts, and once the dispatch ends the next pass starts one', async () => {
  const setup = forge();
  const pulls = [pullRequest(143, { closes: [113], reviews: [review(ago(60))] })];
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
  assert.deepEqual(await setup.syncAndPass(pulls), [REVISE_UNIT]);
});

test('given feedback past its quiet period while a revision of the pull request is running, when the pass runs, then no revision starts, and once it ends the next pass starts one covering the held feedback', async () => {
  const setup = forge({ maxConcurrent: 5 });
  const first = [pullRequest(143, { reviews: [review(ago(60))] })];
  assert.deepEqual(await setup.syncAndPass(first), [REVISE_UNIT]);
  const running = setup.withStore((store) => {
    const start = store.startRevision(
      { repository: 'forge', number: 143, url: 'https://github.com/rameezk/forge/pull/143' },
      [],
      'run-revision',
      ago(45),
      5,
    );
    assert.ok('started' in start);
    store.touchRevision(start.started, new Date().toISOString());
    return start.started;
  });

  const held = [pullRequest(143, { reviews: [review(ago(60)), review(ago(30))] })];
  assert.deepEqual(await setup.syncAndPass(held), []);

  setup.withStore((store) => store.endRevision(running, 'ok', new Date().toISOString()));
  assert.deepEqual(await setup.syncAndPass(held), [REVISE_UNIT]);
});

test('given feedback past its quiet period while a conflict resolution of the pull request is running, when the pass runs, then no revision starts, and once it ends the next pass starts one', async () => {
  const setup = forge({ maxConcurrent: 5 });
  const pulls = [pullRequest(143, { reviews: [review(ago(60))] })];
  const running = setup.withStore((store) => {
    const start = store.startConflictResolution(
      { repository: 'forge', number: 143, url: 'https://github.com/rameezk/forge/pull/143' },
      [],
      'run-conflict',
      new Date().toISOString(),
      5,
      { headSha: 'head-a', defaultSha: 'default-a' },
    );
    assert.ok('started' in start);
    return start.started;
  });

  assert.deepEqual(await setup.syncAndPass(pulls), []);

  setup.withStore((store) => store.endConflictResolution(running, 'ok', new Date().toISOString()));
  assert.deepEqual(await setup.syncAndPass(pulls), [REVISE_UNIT]);
});

test('given dispatch.maxConcurrent live workloads, when a pull request\'s feedback passes its quiet period, then no revision starts until a slot frees', async () => {
  const setup = forge({ maxConcurrent: 1 });
  const pulls = [pullRequest(143, { reviews: [review(ago(60))] })];
  const dispatch = setup.withStore((store) =>
    startedDispatch(store, 'forge', 7, 'run-dispatch', new Date().toISOString()),
  );

  assert.deepEqual(await setup.syncAndPass(pulls), []);

  setup.withStore((store) =>
    store.endDispatch(dispatch, { state: 'failed', reason: 'errored', detail: null }, new Date().toISOString()),
  );
  assert.deepEqual(await setup.syncAndPass(pulls), [REVISE_UNIT]);
});

test('given a revision that ended in error and no newer feedback, when later syncs and passes run, then no revision starts, and new feedback starts one', async () => {
  const setup = forge();
  const old = [pullRequest(143, { reviews: [review(ago(60))] })];
  assert.deepEqual(await setup.syncAndPass(old), [REVISE_UNIT]);
  setup.revise(143, 45, 'error');

  assert.deepEqual(await setup.syncAndPass(old), []);
  assert.deepEqual(await setup.syncAndPass(old), []);

  const newer = [pullRequest(143, { reviews: [review(ago(60)), review(ago(30))] })];
  assert.deepEqual(await setup.syncAndPass(newer), [REVISE_UNIT]);
});

test('given watched pull requests that are merged and closed, when feedback is left on them afterwards, then no revision starts, and if the closed one is reopened its new feedback starts a revision', async () => {
  const setup = forge({ maxConcurrent: 5 });
  const open = [
    pullRequest(143, { reviews: [review(ago(60))] }),
    pullRequest(144, { reviews: [review(ago(60))] }),
  ];
  assert.deepEqual(await setup.syncAndPass(open), [
    'start --no-block --no-ask-password -- forge-revise@forge:143.service',
    'start --no-block --no-ask-password -- forge-revise@forge:144.service',
  ]);
  setup.revise(143, 45);
  setup.revise(144, 45);

  const settled = [
    pullRequest(143, { state: 'MERGED', reviews: [review(ago(60)), review(ago(30))] }),
    pullRequest(144, { state: 'CLOSED', reviews: [review(ago(60)), review(ago(30))] }),
  ];
  assert.deepEqual(await setup.syncAndPass(settled), []);

  const reopened = [
    pullRequest(144, { reviews: [review(ago(60)), review(ago(30)), review(ago(20))] }),
  ];
  assert.deepEqual(await setup.syncAndPass(reopened), [
    'start --no-block --no-ask-password -- forge-revise@forge:144.service',
  ]);
});

test('given feedback.quietPeriod = 2min, when feedback is three minutes old, then a revision starts', async () => {
  const setup = forge({ quietPeriodSeconds: 120 });
  assert.deepEqual(
    await setup.syncAndPass([pullRequest(143, { reviews: [review(ago(3))] })]),
    [REVISE_UNIT],
  );
});

test('given a repository with no feedback worker, when sync and the pass run past the quiet period, then no revision starts', async () => {
  const setup = forge({ feedbackWorker: false });
  assert.deepEqual(
    await setup.syncAndPass([pullRequest(143, { reviews: [review(ago(60))] })]),
    [],
  );
});

test('given a revision started by hand before any sync recorded the pull request\'s feedback, when sync and the pass run past the quiet period, then no revision starts for the feedback it covered', async () => {
  const setup = forge();
  setup.revise(143, 5);
  assert.deepEqual(
    await setup.syncAndPass([pullRequest(143, { reviews: [review(ago(60))] })]),
    [],
  );
});
