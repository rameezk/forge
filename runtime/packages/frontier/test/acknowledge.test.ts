import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import { main } from '../src/main.ts';
import {
  APP_ID,
  APP_SLUG,
  fakeGithubApp,
  routedThrough,
  sentWith,
  tokenFor,
} from '../../shared/test/fixtures/fake-github-app.ts';
import { withProtectedRepositories } from '../../shared/test/fixtures/branch-rules.ts';

const MINUTE = 60_000;

const ago = (minutes: number): string => new Date(Date.now() - minutes * MINUTE).toISOString();

interface Person {
  login: string;
  type: 'User' | 'Bot';
  permission: string;
}

const MAINTAINER: Person = { login: 'reviewer', type: 'User', permission: 'write' };
const OUTSIDER: Person = { login: 'stranger', type: 'User', permission: 'read' };
const FORGE: Person = { login: APP_SLUG, type: 'Bot', permission: 'none' };

interface Item {
  id: string;
  author: Person;
  at: string;
  eyes: Person[];
}

interface Review extends Item {
  body: string;
  inline: Item[];
}

interface Pull {
  number: number;
  author: Person;
  reviews: Review[];
  comments: Item[];
}

let counter = 0;

const item = (at: string, author: Person = MAINTAINER, eyes: Person[] = []): Item => ({
  id: `node-${++counter}`,
  author,
  at,
  eyes,
});

const review = (at: string, body: string, inline: Item[], eyes: Person[] = []): Review => ({
  ...item(at, MAINTAINER, eyes),
  body,
  inline,
});

const pull = (number: number, overrides: Partial<Pull> = {}): Pull => ({
  number,
  author: FORGE,
  reviews: [],
  comments: [],
  ...overrides,
});

const actor = ({ login, type }: Person) => ({ __typename: type, login });

const reactionGroups = (eyes: Person[], viewer: Person | null) =>
  eyes.length === 0
    ? []
    : [
        {
          content: 'EYES',
          viewerHasReacted: viewer !== null && eyes.some(({ login }) => login === viewer.login),
        },
      ];

const watchedNode = (p: Pull) => ({
  number: p.number,
  url: `https://github.com/rameezk/forge/pull/${p.number}`,
  mergeable: 'MERGEABLE',
  headRefOid: `head-${p.number}`,
  author: actor(p.author),
  closingIssuesReferences: { nodes: [] },
  reviews: {
    nodes: p.reviews.map((r) => ({
      author: actor(r.author),
      body: r.body,
      submittedAt: r.at,
      comments: { totalCount: r.inline.length },
    })),
  },
  comments: { nodes: p.comments.map((c) => ({ author: actor(c.author), createdAt: c.at })) },
});

const windowNode = (p: Pull, viewer: Person | null) => ({
  reviews: {
    nodes: p.reviews.map((r) => ({
      id: r.id,
      url: `https://github.com/rameezk/forge/pull/${p.number}#pullrequestreview-${r.id}`,
      author: actor(r.author),
      body: r.body,
      submittedAt: r.at,
      reactionGroups: reactionGroups(r.eyes, viewer),
      comments: {
        nodes: r.inline.map((c) => ({
          id: c.id,
          url: `https://github.com/rameezk/forge/pull/${p.number}#discussion_r${c.id}`,
          author: actor(c.author),
          body: 'Please change this',
          createdAt: c.at,
          path: 'src/index.ts',
          line: 3,
          originalLine: 3,
          reactionGroups: reactionGroups(c.eyes, viewer),
        })),
      },
    })),
  },
  comments: {
    nodes: p.comments.map((c) => ({
      id: c.id,
      url: `https://github.com/rameezk/forge/pull/${p.number}#issuecomment-${c.id}`,
      author: actor(c.author),
      body: 'A thought',
      createdAt: c.at,
      reactionGroups: reactionGroups(c.eyes, viewer),
    })),
  },
});

interface Reaction {
  subjectId: string;
  authorization: string | null;
  query: string;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const github = (pulls: Pull[], refused: string[] = [], viewerKind: 'read' | 'write' = 'read') => {
  const reactions: Reaction[] = [];
  const people = pulls.flatMap((p) => [
    p.author,
    ...p.comments.map((c) => c.author),
    ...p.reviews.flatMap((r) => [r.author, ...r.inline.map((c) => c.author)]),
  ]);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const permission = /^\/repos\/rameezk\/forge\/collaborators\/([^/]+)\/permission$/.exec(
      new URL(String(input)).pathname,
    );
    if (permission !== null) {
      const known = people.find(({ login }) => login === decodeURIComponent(permission[1] as string));
      return known === undefined || known.permission === 'none'
        ? json({}, 404)
        : json({ permission: known.permission });
    }
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, string | number | null>;
    };
    if (/\bmutation\b/.test(body.query)) {
      reactions.push({
        subjectId: String(body.variables.subjectId),
        authorization: new Headers(init?.headers).get('authorization'),
        query: body.query,
      });
      return refused.includes(String(body.variables.subjectId))
        ? json({ data: null, errors: [{ message: 'Resource not accessible by integration' }] })
        : json({ data: { addReaction: { reaction: { content: 'EYES' } } } });
    }
    const viewer = sentWith(init, viewerKind) ? FORGE : null;
    const operation = /query (\w+)/.exec(body.query)?.[1];
    const target = pulls.find(({ number }) => number === body.variables.number);
    const data =
      operation === 'Frontier' || operation === 'ClosedTickets' || operation === 'LabelledIssues'
        ? { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } }
        : operation === 'WatchedPullRequests'
          ? {
              repository: {
                defaultBranchRef: { target: { oid: 'default-a' } },
                pullRequests: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: pulls.map(watchedNode),
                },
              },
            }
          : operation === 'FeedbackWindow' && target !== undefined
            ? { repository: { pullRequest: windowNode(target, viewer) } }
            : undefined;
    if (data === undefined) throw new Error(`unexpected GitHub request ${String(operation)}`);
    return json({ data });
  };
  return { fetch, reactions };
};

const declaring = (repositories: Record<string, { github: string; on: Record<string, string> }>) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'forge-acknowledge-'));
  const configPath = join(stateDir, 'runtime.json');
  const app = fakeGithubApp(Object.values(repositories).map(({ github: name }) => name));
  const keyPath = join(stateDir, 'github-app-private-key');
  writeFileSync(keyPath, app.privateKey);
  writeFileSync(
    configPath,
    JSON.stringify({
      harnesses: { pi: { command: '/bin/false' } },
      workers: { reviser: { harness: 'pi', model: 'z-ai/glm-5', prompt: '/revise {url}' } },
      repositories,
    }),
  );
  return {
    stateDir,
    app,
    env: {
      FORGE_RUNTIME_CONFIG: configPath,
      FORGE_STATE_DIR: stateDir,
      FORGE_GITHUB_APP_ID: APP_ID,
      FORGE_GITHUB_APP_PRIVATE_KEY_FILE: keyPath,
    } as Record<string, string | undefined>,
  };
};

const FEEDBACK_REPOSITORY = { forge: { github: 'rameezk/forge', on: { feedback: 'reviser' } } };

const revised = (stateDir: string, number: number, startedMinutesAgo: number, end: boolean): void => {
  const store = Store.open(join(stateDir, 'forge.db'));
  try {
    const started = store.startRevision(
      { repository: 'forge', number, url: `https://github.com/rameezk/forge/pull/${number}` },
      [],
      randomUUID(),
      ago(startedMinutesAgo),
      Number.POSITIVE_INFINITY,
    );
    assert.ok('started' in started);
    if (end) store.endRevision(started.started, 'done', ago(startedMinutesAgo - 1));
  } finally {
    store.close();
  }
};

const watchedFeedback = (stateDir: string, number: number): string | null => {
  const store = Store.open(join(stateDir, 'forge.db'));
  try {
    const due = store.feedbackDue(new Date(Date.now() + 365 * 24 * 60 * MINUTE).toISOString(), 0);
    return due.some((pullRequest) => pullRequest.number === number) ? 'due' : null;
  } finally {
    store.close();
  }
};

const quietly = (t: TestContext): string[] => {
  const lines: string[] = [];
  t.mock.method(console, 'error', (line: unknown) => {
    lines.push(String(line));
  });
  return lines;
};

const syncWith = (
  setup: ReturnType<typeof declaring>,
  fake: ReturnType<typeof github>,
): Promise<number> => main(['sync'], setup.env, routedThrough(setup.app, withProtectedRepositories(fake.fetch)));

const reactedTo = (fake: ReturnType<typeof github>): string[] =>
  fake.reactions.map(({ subjectId }) => subjectId).sort();

const REACTIONS_TOKEN = `bearer ${tokenFor('reactions', 'rameezk/forge')}`;

test('given an open forge pull request holding a maintainer review summary, an inline comment, a reply in that thread and a conversation comment, all newer than its cursor and without the App\'s eyes, when sync runs, then each of the four gets an EYES reaction written with the reactions token scoped to that repository alone, and the exit code is zero', async (t) => {
  quietly(t);
  const setup = declaring(FEEDBACK_REPOSITORY);
  revised(setup.stateDir, 7, 60, true);
  const inline = item(ago(20));
  const reply = item(ago(19));
  const summary = review(ago(20), 'Please rename this', [inline]);
  const threadReply = review(ago(19), '', [reply]);
  const conversation = item(ago(18));
  const fake = github([pull(7, { reviews: [summary, threadReply], comments: [conversation] })]);

  const code = await syncWith(setup, fake);

  assert.equal(code, 0);
  assert.deepEqual(reactedTo(fake), [summary.id, inline.id, reply.id, conversation.id].sort());
  assert.ok(fake.reactions.every(({ query }) => query.includes('addReaction') && query.includes('EYES')));
  assert.ok(fake.reactions.every(({ authorization }) => authorization === REACTIONS_TOKEN));
  const mints = setup.app.mints.filter(({ kind }) => kind === 'reactions');
  assert.equal(mints.length, 1);
  assert.deepEqual(mints[0]?.body, {
    repositories: ['forge'],
    permissions: { issues: 'write', pull_requests: 'write' },
  });
});

test('given the same feedback where each item already carries the App\'s eyes, when sync runs, then no reaction is written and no reactions token is minted', async (t) => {
  quietly(t);
  const setup = declaring(FEEDBACK_REPOSITORY);
  revised(setup.stateDir, 7, 60, true);
  const fake = github([
    pull(7, {
      reviews: [
        review(ago(20), 'Please rename this', [item(ago(20), MAINTAINER, [FORGE])], [FORGE]),
        review(ago(19), '', [item(ago(19), MAINTAINER, [FORGE])]),
      ],
      comments: [item(ago(18), MAINTAINER, [FORGE])],
    }),
  ]);

  const code = await syncWith(setup, fake);

  assert.equal(code, 0);
  assert.deepEqual(fake.reactions, []);
  assert.equal(setup.app.mints.filter(({ kind }) => kind === 'reactions').length, 0);
});

test('given feedback the App has reacted to with eyes, when sync reads it with a token for a different identity, then it reads as unacknowledged and the App adds eyes again', async (t) => {
  quietly(t);
  const setup = declaring(FEEDBACK_REPOSITORY);
  revised(setup.stateDir, 7, 60, true);
  const comment = item(ago(18), MAINTAINER, [FORGE]);
  const fake = github([pull(7, { comments: [comment] })], [], 'write');

  const code = await syncWith(setup, fake);

  assert.equal(code, 0);
  assert.deepEqual(reactedTo(fake), [comment.id]);
});

test('given a maintainer comment newer than the cursor that carries a person\'s eyes but not the App\'s, when sync runs, then the App adds its eyes', async (t) => {
  quietly(t);
  const setup = declaring(FEEDBACK_REPOSITORY);
  revised(setup.stateDir, 7, 60, true);
  const comment = item(ago(18), MAINTAINER, [OUTSIDER]);
  const fake = github([pull(7, { comments: [comment] })]);

  const code = await syncWith(setup, fake);

  assert.equal(code, 0);
  assert.deepEqual(reactedTo(fake), [comment.id]);
});

test('given a comment by someone without write access, a comment by the App, a maintainer comment older than the cursor, and a maintainer review with an empty summary and one inline comment, when sync runs, then only the inline comment gets eyes', async (t) => {
  quietly(t);
  const setup = declaring(FEEDBACK_REPOSITORY);
  revised(setup.stateDir, 7, 30, true);
  const inline = item(ago(10));
  const fake = github([
    pull(7, {
      reviews: [review(ago(10), '', [inline])],
      comments: [item(ago(10), OUTSIDER), item(ago(10), FORGE), item(ago(40))],
    }),
  ]);

  const code = await syncWith(setup, fake);

  assert.equal(code, 0);
  assert.deepEqual(reactedTo(fake), [inline.id]);
});

test('given a pull request whose revision is running with its cursor at the revision\'s start, and a maintainer comment left after that, when sync runs, then the comment gets eyes', async (t) => {
  quietly(t);
  const setup = declaring(FEEDBACK_REPOSITORY);
  revised(setup.stateDir, 7, 5, false);
  const during = item(ago(2));
  const before = item(ago(8));
  const fake = github([pull(7, { comments: [before, during] })]);

  const code = await syncWith(setup, fake);

  assert.equal(code, 0);
  assert.deepEqual(reactedTo(fake), [during.id]);
});

test('given a repository with only on.conflict holding maintainer comments on a forge pull request, and a repository with on.feedback holding maintainer comments on a pull request opened by a person, when sync runs, then no reaction is written in either', async (t) => {
  quietly(t);
  const setup = declaring({
    conflicts: { github: 'rameezk/forge', on: { conflict: 'resolver' } },
  });
  const forgePull = pull(7, { comments: [item(ago(18))] });
  const conflictOnly = github([forgePull]);

  assert.equal(await syncWith(setup, conflictOnly), 0);
  assert.deepEqual(conflictOnly.reactions, []);

  const feedbackSetup = declaring(FEEDBACK_REPOSITORY);
  const personPull = github([pull(8, { author: MAINTAINER, comments: [item(ago(18))] })]);

  assert.equal(await syncWith(feedbackSetup, personPull), 0);
  assert.deepEqual(personPull.reactions, []);
});

test('given two new maintainer comments on a watched pull request where GitHub refuses the reaction on the first, when sync runs, then the second still gets eyes, the pull request is still recorded with its newest feedback time, the refusal is reported and the exit code is non-zero', async (t) => {
  const errors = quietly(t);
  const setup = declaring(FEEDBACK_REPOSITORY);
  const first = item(ago(20));
  const second = item(ago(19));
  const fake = github([pull(7, { comments: [first, second] })], [first.id]);

  const code = await syncWith(setup, fake);

  assert.equal(code, 1);
  assert.deepEqual(reactedTo(fake), [first.id, second.id].sort());
  assert.equal(watchedFeedback(setup.stateDir, 7), 'due');
  assert.ok(
    errors.some((line) => line.includes('rameezk/forge') && line.includes('Resource not accessible by integration')),
    errors.join('\n'),
  );
});
