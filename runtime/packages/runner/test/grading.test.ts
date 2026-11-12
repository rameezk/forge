import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '@forge/shared';
import { main as sync } from '../../frontier/src/main.ts';
import { main as grade } from '../src/grading-main.ts';
import { jevDecides } from '../src/grading.ts';
import {
  APP_ID,
  APP_SLUG,
  fakeGithubApp,
  routedThrough,
} from '../../shared/test/fixtures/fake-github-app.ts';
import { withProtectedRepositories } from '../../shared/test/fixtures/branch-rules.ts';
import { journaled } from './helpers.ts';

interface FakePull {
  number: number;
  author: 'Bot' | 'User';
  draft?: boolean;
  closes?: number[];
  head?: string;
  title?: string;
  body?: string;
}

interface FakeFile {
  filename: string;
  additions: number;
  deletions: number;
  patch: string;
}

const FILES: FakeFile[] = [
  { filename: 'src/billing.ts', additions: 12, deletions: 3, patch: '@@ -1,3 +1,12 @@\n+const charge = 1;' },
  { filename: 'package-lock.json', additions: 400, deletions: 120, patch: '@@ -1 +1 @@\n+LOCKFILE-CONTENT-MARKER' },
];

interface Answer {
  status?: number;
  body: unknown;
}

const decision = (probabilities: Record<string, number>, confidence: number): Answer => ({
  body: {
    id: 'dec-1',
    model: 'typesafe/jev-1.13',
    answers: {
      risk: { type: 'score', score: 0.4, confidence, probabilities },
    },
    usage: { cost: 0.0042, input_tokens: 900, output_tokens: 1 },
  },
});

const forge = async (grading: { on: boolean; model?: string; confidenceThreshold?: number } = { on: true }) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'forge-grading-'));
  const configPath = join(stateDir, 'runtime.json');
  const writeConfig = (model: string): void =>
    writeFileSync(
      configPath,
      JSON.stringify({
        harnesses: {},
        workers: {},
        repositories: {
          forge: { github: 'rameezk/forge', ...(grading.on ? { grading: true } : {}) },
        },
        grading: {
          model,
          ...(grading.confidenceThreshold === undefined
            ? {}
            : { confidenceThreshold: grading.confidenceThreshold }),
        },
      }),
    );
  writeConfig(grading.model ?? 'typesafe/jev-1.13');
  const app = fakeGithubApp(['rameezk/forge']);
  const keyPath = join(stateDir, 'github-app-private-key');
  writeFileSync(keyPath, app.privateKey);

  const jevRequests: { authorization: string | undefined; body: Record<string, unknown> }[] = [];
  let answer: Answer = decision({ trivial: 0.1, low: 0.7, moderate: 0.15, high: 0.05 }, 0.9);
  const jev = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      jevRequests.push({
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      });
      response.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => jev.listen(0, '127.0.0.1', resolve));
  const env = {
    FORGE_RUNTIME_CONFIG: configPath,
    FORGE_STATE_DIR: stateDir,
    FORGE_GITHUB_APP_ID: APP_ID,
    FORGE_GITHUB_APP_PRIVATE_KEY_FILE: keyPath,
    OPENROUTER_API_KEY: 'sk-or-test',
    OPENROUTER_BASE_URL: `http://127.0.0.1:${(jev.address() as AddressInfo).port}/api/v1`,
  };

  let pulls: FakePull[] = [];
  const ended = new Map<number, { state: 'OPEN' | 'MERGED' | 'CLOSED'; head: string }>();
  let files = FILES;
  let checkRunsAccepted = true;
  let labelDeletesRefused = 0;
  const labels = new Map<number, Set<string>>([[7, new Set(['bug'])]]);
  const checkRuns: { authorization: string; body: Record<string, unknown> }[] = [];
  const github: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const json = (data: unknown): Response =>
      new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/repos/rameezk/forge/check-runs' && init?.method === 'POST') {
      if (!checkRunsAccepted) return new Response('{}', { status: 403 });
      const authorization = new Headers(init.headers).get('authorization') ?? '';
      assert.match(authorization, /^Bearer ghs_grading_/);
      checkRuns.push({
        authorization,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      return json({ id: 1 });
    }
    const labelsOf = /^\/repos\/rameezk\/forge\/issues\/(\d+)\/labels(?:\/(.+))?$/.exec(url.pathname);
    if (labelsOf !== null) {
      assert.match(new Headers(init?.headers).get('authorization') ?? '', /^Bearer ghs_grading_/);
      const labelled = labels.get(Number(labelsOf[1])) ?? new Set<string>();
      labels.set(Number(labelsOf[1]), labelled);
      if (init?.method === 'POST') {
        for (const name of (JSON.parse(String(init.body)) as { labels: string[] }).labels) labelled.add(name);
      } else if (init?.method === 'DELETE') {
        if (labelDeletesRefused > 0) {
          labelDeletesRefused -= 1;
          return new Response('{}', { status: 500 });
        }
        if (!labelled.delete(decodeURIComponent(labelsOf[2] ?? ''))) return new Response('{}', { status: 404 });
        return json([...labelled].map((name) => ({ name })));
      }
      return json([...labelled].map((name) => ({ name })));
    }
    const pullOf = /^\/repos\/rameezk\/forge\/pulls\/(\d+)(\/files)?$/.exec(url.pathname);
    if (pullOf !== null) {
      const pull = pulls.find(({ number }) => number === Number(pullOf[1]));
      if (pull === undefined) return new Response('{}', { status: 404 });
      return pullOf[2] === undefined
        ? json({
            number: pull.number,
            state: 'open',
            draft: pull.draft ?? false,
            title: pull.title,
            body: pull.body,
            head: { sha: pull.head ?? `head-${pull.number}` },
          })
        : json(files);
    }
    if (url.pathname === '/repos/rameezk/forge/pulls/7/commits') return json([]);
    const body = JSON.parse(String(init?.body)) as { query: string; variables: { number: number } };
    const { variables } = body;
    const operation = /query (\w+)/.exec(body.query)?.[1];
    const empty = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
    const data =
      operation === 'Frontier' || operation === 'ClosedTickets' || operation === 'LabelledIssues'
        ? { repository: { issues: empty } }
        : operation === 'WatchedPullRequests'
          ? {
              repository: {
                defaultBranchRef: { target: { oid: 'default-a' } },
                pullRequests: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: pulls.map((pull) => ({
                    number: pull.number,
                    url: `https://github.com/rameezk/forge/pull/${pull.number}`,
                    mergeable: 'MERGEABLE',
                    headRefOid: pull.head ?? `head-${pull.number}`,
                    isDraft: pull.draft ?? false,
                    author: {
                      __typename: pull.author,
                      login: pull.author === 'Bot' ? APP_SLUG : 'a-person',
                    },
                    closingIssuesReferences: {
                      nodes: (pull.closes ?? []).map((number) => ({
                        number,
                        repository: { nameWithOwner: 'rameezk/forge' },
                      })),
                    },
                    reviews: { nodes: [] },
                    comments: { nodes: [] },
                  })),
                },
              },
            }
          : operation === 'TicketContext'
            ? {
                repository: {
                  issue: {
                    number: 10,
                    title: 'TICKET-TITLE',
                    url: 'https://github.com/rameezk/forge/issues/10',
                    body: 'TICKET-BODY',
                    comments: { nodes: [] },
                    parent: {
                      number: 5,
                      title: 'SPEC-TITLE',
                      url: 'https://github.com/rameezk/forge/issues/5',
                      body: 'SPEC-BODY',
                      comments: { nodes: [] },
                    },
                  },
                },
              }
            : operation === 'PullRequest'
              ? {
                  repository: {
                    pullRequest: {
                      state: ended.get(variables.number)?.state ?? 'OPEN',
                      headRefOid: ended.get(variables.number)?.head ?? `head-${variables.number}`,
                      mergedAt: null,
                      closedAt: null,
                      commits: empty,
                    },
                  },
                }
              : undefined;
    if (data === undefined) throw new Error(`unexpected GitHub request ${String(operation)}`);
    return json({ data });
  };
  const fetch = routedThrough(app, withProtectedRepositories(github));

  const withStore = <T>(use: (store: Store) => T): T => {
    const store = Store.open(join(stateDir, 'forge.db'));
    try {
      return use(store);
    } finally {
      store.close();
    }
  };

  const syncAndGrade = async (open: FakePull[]): Promise<void> => {
    pulls = open;
    const synced = await journaled(() => sync(['sync'], env, fetch));
    assert.equal(synced.result, 0, synced.journal);
    const graded = await journaled(() => grade(env, fetch));
    assert.equal(graded.result, 0, graded.journal);
  };

  return {
    env,
    fetch,
    setPulls: (next: FakePull[]): void => {
      pulls = next;
    },
    end: (number: number, state: 'MERGED' | 'CLOSED', head: string): void => {
      ended.set(number, { state, head });
    },
    jevRequests,
    checkRuns,
    labelsOf: (number: number): string[] => [...(labels.get(number) ?? [])].sort(),
    withStore,
    syncAndGrade,
    refuseLabelDeletes: (count: number): void => {
      labelDeletesRefused = count;
    },
    acceptCheckRuns: (accepted: boolean): void => {
      checkRunsAccepted = accepted;
    },
    grade: async (): Promise<number> => (await journaled(() => grade(env, fetch))).result,
    answerWith: (next: Answer): void => {
      answer = next;
    },
    changeModel: writeConfig,
    close: (): void => {
      jev.close();
    },
  };
};

const READY: FakePull = {
  number: 7,
  author: 'Bot',
  closes: [10],
  title: 'LOW-RISK-TITLE this is a trivial change',
  body: 'LOW-RISK-BODY nothing can break',
};

test('given grading is on and a ready forge pull request, when frontier sync and forge-grading run, then Jev is sent the ticket, spec, files and diff, the grade is stored with its fingerprint and cost, and a neutral forge/risk check run is posted', async (t) => {
  const f = await forge();
  t.after(f.close);
  await f.syncAndGrade([READY]);

  assert.equal(f.jevRequests.length, 1);
  const [request] = f.jevRequests;
  assert.equal(request?.authorization, 'Bearer sk-or-test');
  assert.equal(request?.body.model, 'typesafe/jev-1.13');
  const sent = JSON.stringify(request?.body);
  for (const expected of ['TICKET-TITLE', 'TICKET-BODY', 'SPEC-TITLE', 'SPEC-BODY', 'src/billing.ts', 'const charge = 1;']) {
    assert.ok(sent.includes(expected), `${expected} is sent`);
  }
  const questions = request?.body.questions as Record<string, { type: string; criteria: string[] }>;
  assert.equal(Object.values(questions)[0]?.type, 'score');
  assert.equal(Object.values(questions)[0]?.criteria.length, 4);

  const grade = f.withStore((store) => store.riskGrade('forge', 7, 'head-7'));
  assert.equal(grade?.level, 'low');
  assert.equal(grade?.unsettled, false);
  assert.equal(grade?.confidence, 0.9);
  assert.equal(grade?.costUsd, 0.0042);
  assert.equal(grade?.model, 'typesafe/jev-1.13');
  assert.match(grade?.fingerprint ?? '', /^typesafe\/jev-1\.13:[0-9a-f]{64}$/);
  assert.deepEqual(grade?.probabilities, { trivial: 0.1, low: 0.7, moderate: 0.15, high: 0.05 });

  assert.equal(f.checkRuns.length, 1);
  const check = f.checkRuns[0]?.body as { name: string; head_sha: string; conclusion: string; output: { title: string; summary: string } };
  assert.equal(check.name, 'forge/risk');
  assert.equal(check.head_sha, 'head-7');
  assert.equal(check.conclusion, 'neutral');
  assert.match(check.output.title, /low/);
  assert.match(check.output.summary, /typesafe\/jev-1\.13/);
  assert.match(check.output.summary, /trivial.*0\.10/s);

  await f.syncAndGrade([READY]);
  assert.equal(f.jevRequests.length, 1);
  assert.equal(f.checkRuns.length, 1);
});

test('given a forge pull request whose title and body call the change low risk, when it is graded, then none of that text reaches Jev', async (t) => {
  const f = await forge();
  t.after(f.close);
  await f.syncAndGrade([READY]);
  const sent = JSON.stringify(f.jevRequests[0]?.body);
  assert.ok(!sent.includes('LOW-RISK'));
});

test('given a pull request changing a lockfile and source, when it is graded, then the lockfile is listed with its line counts and its diff is absent', async (t) => {
  const f = await forge();
  t.after(f.close);
  await f.syncAndGrade([READY]);
  const sent = JSON.stringify(f.jevRequests[0]?.body);
  assert.match(sent, /package-lock\.json/);
  assert.match(sent, /\+400 -120/);
  assert.match(sent, /\+12 -3/);
  assert.ok(!sent.includes('LOCKFILE-CONTENT-MARKER'));
});

test('given Jev puts most probability on low, some on high and confidence below the threshold, when the grade is recorded, then it is low and unsettled and the check run shows high as the runner-up', async (t) => {
  const f = await forge();
  t.after(f.close);
  f.answerWith(decision({ trivial: 0.05, low: 0.5, moderate: 0.1, high: 0.35 }, 0.4));
  await f.syncAndGrade([READY]);
  const grade = f.withStore((store) => store.riskGrade('forge', 7, 'head-7'));
  assert.equal(grade?.level, 'low');
  assert.equal(grade?.unsettled, true);
  const check = f.checkRuns[0]?.body as { output: { summary: string } };
  assert.match(check.output.summary, /Runner-up: high/);
});

test('given a draft, a pull request with a revision running, a human pull request or grading off, when forge-grading runs, then nothing is sent to Jev', async (t) => {
  const on = await forge();
  t.after(on.close);
  on.withStore((store) => {
    const start = store.startRevision(
      { repository: 'forge', number: 8, url: 'https://github.com/rameezk/forge/pull/8' },
      [],
      randomUUID(),
      new Date().toISOString(),
      Number.POSITIVE_INFINITY,
    );
    assert.ok('started' in start);
  });
  await on.syncAndGrade([
    { ...READY, number: 7, draft: true },
    { ...READY, number: 8 },
    { ...READY, number: 9, author: 'User' },
  ]);
  assert.equal(on.jevRequests.length, 0);
  assert.equal(on.checkRuns.length, 0);

  const off = await forge({ on: false });
  t.after(off.close);
  await off.syncAndGrade([READY]);
  assert.equal(off.jevRequests.length, 0);
});

test('given grading was off and a forge pull request is open, when grading is turned on, then the open pull request is recorded and graded', async (t) => {
  const f = await forge({ on: false });
  t.after(f.close);
  await f.syncAndGrade([READY]);
  assert.equal(f.jevRequests.length, 0);
  const configured = await forge({ on: true });
  t.after(configured.close);
  await configured.syncAndGrade([READY]);
  assert.equal(configured.jevRequests.length, 1);
});

test('given grades under one model, when the configured model changes, then new grades carry a different fingerprint', async (t) => {
  const f = await forge();
  t.after(f.close);
  await f.syncAndGrade([READY]);
  f.changeModel('typesafe/jev-1.14');
  await f.syncAndGrade([{ ...READY, number: 11 }]);
  const [first, second] = f.withStore((store) => [
    store.riskGrade('forge', 7, 'head-7')?.fingerprint,
    store.riskGrade('forge', 11, 'head-11')?.fingerprint,
  ]);
  assert.ok(first !== undefined && second !== undefined && first !== second);
});

test('given the check run is refused after Jev graded the head, when forge-grading runs again once it is accepted, then the check run is posted without asking Jev again', async (t) => {
  const f = await forge();
  t.after(f.close);
  f.acceptCheckRuns(false);
  f.setPulls([READY]);
  const synced = await journaled(() => sync(['sync'], f.env, f.fetch));
  assert.equal(synced.result, 0, synced.journal);
  assert.equal(await f.grade(), 1);
  assert.equal(f.jevRequests.length, 1);
  assert.equal(f.checkRuns.length, 0);
  assert.equal(f.withStore((store) => store.riskGrade('forge', 7, 'head-7')?.level), 'low');

  f.acceptCheckRuns(true);
  assert.equal(await f.grade(), 0);
  assert.equal(f.jevRequests.length, 1);
  assert.equal(f.checkRuns.length, 1);

  assert.equal(await f.grade(), 0);
  assert.equal(f.checkRuns.length, 1);
});

test('given a forge pull request graded moderate, when forge-grading runs, then it carries forge:risk-moderate and no other risk label', async (t) => {
  const f = await forge();
  t.after(f.close);
  f.answerWith(decision({ trivial: 0.05, low: 0.15, moderate: 0.7, high: 0.1 }, 0.9));
  await f.syncAndGrade([READY]);
  assert.deepEqual(f.labelsOf(7), ['bug', 'forge:risk-moderate']);
});

test('given a grade below the confidence threshold, when it is recorded, then the pull request carries its level label and forge:risk-unsettled', async (t) => {
  const f = await forge();
  t.after(f.close);
  f.answerWith(decision({ trivial: 0.05, low: 0.5, moderate: 0.1, high: 0.35 }, 0.4));
  await f.syncAndGrade([READY]);
  assert.deepEqual(f.labelsOf(7), ['bug', 'forge:risk-low', 'forge:risk-unsettled']);
});

test('given a graded forge pull request, when a revision pushes a new head, then the risk labels come off before the revision ends and the new head has no check run until the revision ends and it is regraded', async (t) => {
  const f = await forge();
  t.after(f.close);
  await f.syncAndGrade([READY]);
  assert.deepEqual(f.labelsOf(7), ['bug', 'forge:risk-low']);

  const revision = f.withStore((store) => {
    const start = store.startRevision(
      { repository: 'forge', number: 7, url: 'https://github.com/rameezk/forge/pull/7' },
      [],
      randomUUID(),
      new Date().toISOString(),
      Number.POSITIVE_INFINITY,
    );
    assert.ok('started' in start);
    return start.started;
  });
  const revised = { ...READY, head: 'head-7-revised' };
  f.answerWith(decision({ trivial: 0.6, low: 0.2, moderate: 0.1, high: 0.1 }, 0.9));
  await f.syncAndGrade([revised]);
  assert.deepEqual(f.labelsOf(7), ['bug']);
  assert.equal(f.jevRequests.length, 1);
  assert.equal(f.checkRuns.length, 1);

  f.withStore((store) => store.endRevision(revision, 'done', new Date().toISOString()));
  await f.syncAndGrade([revised]);
  assert.equal(f.jevRequests.length, 2);
  assert.equal(f.checkRuns.length, 2);
  assert.equal((f.checkRuns[1]?.body as { head_sha: string }).head_sha, 'head-7-revised');
  assert.deepEqual(f.labelsOf(7), ['bug', 'forge:risk-trivial']);
});

test('given removing the stale labels failed once, when the new head is graded and forge-grading runs again, then the new grade keeps its labels', async (t) => {
  const f = await forge();
  t.after(f.close);
  await f.syncAndGrade([READY]);
  f.refuseLabelDeletes(1);
  f.setPulls([{ ...READY, head: 'head-7-revised' }]);
  const synced = await journaled(() => sync(['sync'], f.env, f.fetch));
  assert.equal(synced.result, 0, synced.journal);
  assert.equal(await f.grade(), 1);
  assert.deepEqual(f.labelsOf(7), ['bug', 'forge:risk-low']);
  assert.equal(await f.grade(), 0);
  assert.deepEqual(f.labelsOf(7), ['bug', 'forge:risk-low']);
  assert.equal(f.jevRequests.length, 2);
  assert.equal(f.withStore((store) => store.riskGrade('forge', 7, 'head-7-revised')?.level), 'low');
});

const revise = (store: Store, number: number): void => {
  const start = store.startRevision(
    { repository: 'forge', number, url: `https://github.com/rameezk/forge/pull/${number}` },
    [],
    randomUUID(),
    '2026-01-01T00:00:00.000Z',
    Number.POSITIVE_INFINITY,
  );
  assert.ok('started' in start);
  store.endRevision(start.started, 'done', '2026-01-01T00:01:00.000Z');
};

test('given a graded commit of a pull request that went through two revisions, when it is merged at that commit, then the grade reads merged with two revisions', async (t) => {
  const f = await forge();
  t.after(f.close);
  f.withStore((store) => {
    revise(store, 7);
    revise(store, 7);
  });
  await f.syncAndGrade([READY]);
  assert.equal(f.withStore((store) => store.riskGrade('forge', 7, 'head-7')?.outcome), 'open');

  f.end(7, 'MERGED', 'head-7');
  await f.syncAndGrade([]);
  const grade = f.withStore((store) => store.riskGrade('forge', 7, 'head-7'));
  assert.equal(grade?.outcome, 'merged');
  assert.equal(grade?.revisions, 2);
});

test('given a graded commit, when the pull request receives a new head, then the earlier grade reads superseded', async (t) => {
  const f = await forge();
  t.after(f.close);
  await f.syncAndGrade([READY]);
  await f.syncAndGrade([{ ...READY, head: 'head-7b' }]);
  const [earlier, later] = f.withStore((store) => [
    store.riskGrade('forge', 7, 'head-7'),
    store.riskGrade('forge', 7, 'head-7b'),
  ]);
  assert.equal(earlier?.outcome, 'superseded');
  assert.equal(later?.outcome, 'open');
});

test('given a graded commit, when the pull request is closed without merging, then the grade reads closed', async (t) => {
  const f = await forge();
  t.after(f.close);
  await f.syncAndGrade([READY]);
  f.end(7, 'CLOSED', 'head-7');
  await f.syncAndGrade([]);
  assert.equal(f.withStore((store) => store.riskGrade('forge', 7, 'head-7')?.outcome), 'closed');
});

test('given a graded commit, when the pull request merges at a newer head, then the earlier grade reads superseded', async (t) => {
  const f = await forge();
  t.after(f.close);
  await f.syncAndGrade([READY]);
  f.end(7, 'MERGED', 'head-7b');
  await f.syncAndGrade([]);
  assert.equal(f.withStore((store) => store.riskGrade('forge', 7, 'head-7')?.outcome), 'superseded');
});

const SCORE_BODY = {
  answers: { risk: { type: 'score', score: 0.4, confidence: 0.9, probabilities: { trivial: 0.1, low: 0.7, moderate: 0.15, high: 0.05 } } },
  usage: { cost: 0.001 },
};

const failureOf = async (respond: () => Response | Promise<Response>): Promise<{ category?: string; message?: string; detail?: string }> => {
  const decide = jevDecides(
    new URL('http://openrouter.test/api/alpha/decisions'),
    'sk-or-test',
    'typesafe/jev-1.13',
    (async () => respond()) as typeof globalThis.fetch,
  );
  try {
    await decide('state');
  } catch (error) {
    return error as { category?: string; message?: string; detail?: string };
  }
  return {};
};

const errorResponse = (status: number, message: string, metadata?: Record<string, unknown>): Response =>
  new Response(JSON.stringify({ error: { code: status, message, ...(metadata === undefined ? {} : { metadata }) } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

test('given each error OpenRouter documents, when Jev is asked, then the failure falls in the category that decides whether it is retried', async () => {
  const cases: [string, () => Response | Promise<Response>, string][] = [
    ['401 invalid credentials', () => errorResponse(401, 'No auth credentials found'), 'setup'],
    ['402 insufficient credits', () => errorResponse(402, 'Insufficient credits'), 'setup'],
    ['403 forbidden', () => errorResponse(403, 'Key limit exceeded'), 'setup'],
    ['404 model not found', () => errorResponse(404, 'No endpoints found for typesafe/jev-1.13'), 'setup'],
    ['408 timed out', () => errorResponse(408, 'Request timed out'), 'temporary'],
    ['429 rate limited', () => errorResponse(429, 'Rate limit exceeded'), 'temporary'],
    ['500 server error', () => errorResponse(500, 'Internal Server Error'), 'temporary'],
    ['502 provider down', () => errorResponse(502, 'Provider returned error'), 'temporary'],
    ['503 unavailable', () => errorResponse(503, 'Service unavailable'), 'temporary'],
    ['504 timeout', () => errorResponse(504, 'Gateway timeout'), 'temporary'],
    ['524 edge timeout', () => errorResponse(524, 'Timeout'), 'temporary'],
    ['529 overloaded', () => errorResponse(529, 'Overloaded'), 'temporary'],
    ['an error body behind a 200', () => new Response(JSON.stringify({ error: { code: 502, message: 'Upstream failed' } })), 'temporary'],
    ['a dropped connection', () => Promise.reject(new TypeError('fetch failed')), 'temporary'],
    ['a client timeout', () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), 'temporary'],
    ['413 payload too large', () => errorResponse(413, 'Payload too large'), 'too-large'],
    ['400 context length exceeded by type', () => errorResponse(400, 'Request rejected', { error_type: 'context_length_exceeded' }), 'too-large'],
    ['400 context length exceeded by message', () => errorResponse(400, "This model's maximum context length is 262144 tokens"), 'too-large'],
    ['400 exceeding a rate limit', () => errorResponse(400, 'request exceeds the rate limit of the key'), 'bug'],
    ['400 bad request', () => errorResponse(400, 'questions.risk.criteria must not be empty'), 'bug'],
    ['422 validation', () => errorResponse(422, 'Invalid criteria'), 'bug'],
    ['a refusal', () => new Response(JSON.stringify({ answers: { risk: { type: 'refusal' } } })), 'declined'],
    ['a non-score answer', () => new Response(JSON.stringify({ answers: { risk: { type: 'choice' } } })), 'bug'],
    ['a body read that times out', () => ({ ok: true, status: 200, json: () => Promise.reject(new DOMException('timed out', 'TimeoutError')) }) as unknown as Response, 'temporary'],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 }), 'bug'],
  ];
  for (const [name, respond, expected] of cases) {
    assert.equal((await failureOf(respond)).category, expected, name);
  }
  assert.equal((await failureOf(() => new Response(JSON.stringify(SCORE_BODY)))).category, undefined);
});

test('given the key is rejected, out of credits or the model is gone, when Jev is asked, then the message says so in words an operator can act on', async () => {
  assert.match((await failureOf(() => errorResponse(401, 'No auth credentials found'))).message ?? '', /OpenRouter rejected the key/);
  assert.match((await failureOf(() => errorResponse(402, 'Insufficient credits'))).message ?? '', /no credits/);
  assert.match((await failureOf(() => errorResponse(404, 'No endpoints found'))).message ?? '', /model .* not available/);
  assert.equal((await failureOf(() => errorResponse(503, 'Service unavailable'))).message, 'OpenRouter answered 503');
});

test('given OpenRouter explains a failure, when Jev is asked, then its words stay out of the message that is stored and posted and are kept as detail for the log', async () => {
  const failure = (await failureOf(() => errorResponse(400, 'questions.risk echoed ticket-text'))) as { message?: string; detail?: string };
  assert.equal(failure.message, 'OpenRouter rejected the request with 400');
  assert.match(failure.detail ?? '', /echoed ticket-text/);
});

test('given Jev answers with a server error, when forge-grading runs, then the attempt is recorded as temporary, the check run says it is retrying, and an immediate run sends nothing', async (t) => {
  const f = await forge();
  t.after(f.close);
  f.answerWith({ status: 503, body: { error: { code: 503, message: 'Service unavailable' } } });
  await f.syncAndGrade([READY]);

  assert.equal(f.jevRequests.length, 1);
  const attempts = f.withStore((store) => store.currentGradingAttempts());
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.category, 'temporary');
  assert.equal(attempts[0]?.headSha, 'head-7');
  assert.equal(attempts[0]?.message, 'OpenRouter answered 503');
  assert.equal(f.withStore((store) => store.riskGrade('forge', 7, 'head-7')), null);

  assert.equal(f.checkRuns.length, 1);
  const check = f.checkRuns[0]?.body as { name: string; conclusion: string; output: { title: string } };
  assert.equal(check.name, 'forge/risk');
  assert.equal(check.conclusion, 'neutral');
  assert.equal(check.output.title, 'Not graded: OpenRouter answered 503, retrying');
  assert.deepEqual(f.labelsOf(7), ['bug']);

  await f.syncAndGrade([READY]);
  assert.equal(f.jevRequests.length, 1);
  assert.equal(f.checkRuns.length, 1);
});

test('given OpenRouter rejects the key, when forge-grading runs, then the attempt is recorded as setup and the dashboard status carries the message', async (t) => {
  const f = await forge();
  t.after(f.close);
  f.answerWith({ status: 401, body: { error: { code: 401, message: 'No auth credentials found' } } });
  await f.syncAndGrade([READY]);

  const status = f.withStore((store) => store.gradingStatus());
  assert.equal(status.failure?.category, 'setup');
  assert.match(status.failure?.message ?? '', /OpenRouter rejected the key/);
  const check = f.checkRuns[0]?.body as { output: { title: string } };
  assert.equal(check.output.title, 'Not graded: OpenRouter rejected the key, retrying');
});

test('given Jev declines or the input is too large, when forge-grading runs again on the same head, then no request is sent and the check run says declined or too large', async (t) => {
  for (const [answer, category, title] of [
    [{ body: { answers: { risk: { type: 'refusal' } } } }, 'declined', 'Not graded: Jev declined to answer'],
    [{ status: 413, body: { error: { code: 413, message: 'Payload too large' } } }, 'too-large', 'Not graded: the input does not fit Jev\'s context window'],
  ] as [Answer, string, string][]) {
    const f = await forge();
    t.after(f.close);
    f.answerWith(answer);
    await f.syncAndGrade([READY]);
    await f.syncAndGrade([READY]);
    await f.syncAndGrade([READY]);

    assert.equal(f.jevRequests.length, 1, category);
    assert.equal(f.withStore((store) => store.currentGradingAttempts()[0]?.category), category);
    assert.equal(f.checkRuns.length, 1, category);
    assert.equal((f.checkRuns[0]?.body as { output: { title: string } }).output.title, title);
    assert.equal(f.withStore((store) => store.gradingStatus().failure), null, category);
  }
});

test('given a failure on a head and a new head after a revision, when forge-grading runs, then the new head is asked about at once', async (t) => {
  const f = await forge();
  t.after(f.close);
  f.answerWith({ body: { answers: { risk: { type: 'refusal' } } } });
  await f.syncAndGrade([READY]);
  f.answerWith(decision({ trivial: 0.1, low: 0.7, moderate: 0.15, high: 0.05 }, 0.9));
  await f.syncAndGrade([{ ...READY, head: 'head-7b' }]);

  assert.equal(f.jevRequests.length, 2);
  assert.equal(f.withStore((store) => store.riskGrade('forge', 7, 'head-7b')?.level), 'low');
});

test('given the check run for a failure is refused, when forge-grading runs again once it is accepted, then it is posted without asking Jev again', async (t) => {
  const f = await forge();
  t.after(f.close);
  f.answerWith({ body: { answers: { risk: { type: 'refusal' } } } });
  f.acceptCheckRuns(false);
  f.setPulls([READY]);
  const synced = await journaled(() => sync(['sync'], f.env, f.fetch));
  assert.equal(synced.result, 0, synced.journal);
  assert.equal(await f.grade(), 1);
  assert.equal(f.checkRuns.length, 0);

  f.acceptCheckRuns(true);
  assert.equal(await f.grade(), 0);
  assert.equal(f.jevRequests.length, 1);
  assert.equal(f.checkRuns.length, 1);
  assert.equal(await f.grade(), 0);
  assert.equal(f.checkRuns.length, 1);
});
