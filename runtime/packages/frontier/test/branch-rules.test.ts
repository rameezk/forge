import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import { main } from '../src/main.ts';
import {
  APP_ID,
  fakeGithubApp,
  routedThrough,
  sentWith,
} from '../../shared/test/fixtures/fake-github-app.ts';
import {
  actionsApproving,
  answerRules,
  bypassable,
  PROTECTED,
  unreadable,
  withPullRequest,
  type RepositoryRules,
} from '../../shared/test/fixtures/branch-rules.ts';

const EMPTY_PAGE = {
  data: {
    repository: {
      issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    },
  },
};

const syncing = async (rules: Record<string, RepositoryRules>, stateDir?: string) => {
  const dir = stateDir ?? mkdtempSync(join(tmpdir(), 'forge-branch-rules-'));
  const app = fakeGithubApp(['rameezk/forge']);
  const keyPath = join(dir, 'github-app-private-key');
  writeFileSync(keyPath, app.privateKey);
  const configPath = join(dir, 'runtime.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      harnesses: {},
      workers: {},
      repositories: { forge: { github: 'rameezk/forge' } },
    }),
  );
  const requests: { pathname: string; authorization: string | null; init?: RequestInit }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const { pathname, search } = new URL(String(input));
    requests.push({
      pathname,
      authorization: new Headers(init?.headers).get('authorization'),
      ...(init === undefined ? {} : { init }),
    });
    const answer = answerRules(pathname, rules, search);
    return new Response(JSON.stringify(answer === null ? EMPTY_PAGE : answer.body), {
      status: answer?.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const logged: string[] = [];
  const error = console.error;
  console.error = (line: unknown) => {
    logged.push(String(line));
  };
  let code: number;
  try {
    code = await main(['sync'], {
      FORGE_RUNTIME_CONFIG: configPath,
      FORGE_STATE_DIR: dir,
      FORGE_GITHUB_APP_ID: APP_ID,
      FORGE_GITHUB_APP_PRIVATE_KEY_FILE: keyPath,
    }, routedThrough(app, fetch));
  } finally {
    console.error = error;
  }
  const store = Store.open(join(dir, 'forge.db'));
  try {
    return { code, dir, app, requests, logged, branchRules: store.listFrontier()[0]?.branchRules };
  } finally {
    store.close();
  }
};

test('given a repository meeting every rule, when sync runs, then it is verified with no failing rule', async () => {
  const { code, branchRules, logged } = await syncing({ 'rameezk/forge': PROTECTED });

  assert.equal(code, 0);
  assert.deepEqual(branchRules, []);
  assert.deepEqual(logged, []);
});

test('given a default branch requiring no approving review, when sync runs, then the repository and the missing rule are logged and stored', async () => {
  const { branchRules, logged } = await syncing({
    'rameezk/forge': withPullRequest({ approvals: 0, lastPushApproval: true }),
  });

  assert.deepEqual(branchRules, ['its default branch does not require an approving review']);
  assert.deepEqual(logged, [
    'forge: no new work, its default branch does not require an approving review',
  ]);
});

test('given a default branch with no pull request rule, when sync runs, then both review rules are missing', async () => {
  const { branchRules } = await syncing({ 'rameezk/forge': { ...PROTECTED, rulesets: [] } });

  assert.deepEqual(branchRules, [
    'its default branch does not require an approving review',
    'its default branch does not require approval of the most recent push',
  ]);
});

test('given a default branch not requiring approval of the latest push, when sync runs, then it names that rule alone', async () => {
  const { branchRules } = await syncing({
    'rameezk/forge': withPullRequest({ approvals: 2, lastPushApproval: false }),
  });

  assert.deepEqual(branchRules, [
    'its default branch does not require approval of the most recent push',
  ]);
});

for (const mode of ['always', 'pull_requests_only', 'exempt'] as const) {
  test(`given a ruleset the App can bypass as ${mode}, when sync runs, then it names the ruleset`, async () => {
    const { branchRules } = await syncing({ 'rameezk/forge': bypassable(mode) });

    assert.deepEqual(branchRules, ['forge\'s App can bypass the ruleset "protect main"']);
  });
}

test('given Actions allowed to approve pull requests, when sync runs, then it names that rule alone', async () => {
  const { branchRules } = await syncing({ 'rameezk/forge': actionsApproving });

  assert.deepEqual(branchRules, ['GitHub Actions can approve pull requests']);
});

test('given rules GitHub answers 403, when sync runs, then the reason says the rules could not be read', async () => {
  const { branchRules, code } = await syncing({ 'rameezk/forge': unreadable });

  assert.equal(code, 0);
  assert.deepEqual(branchRules, [
    'its default branch rules could not be read: GitHub answered 403: Upgrade to GitHub Pro or make this repository public to enable this feature.',
  ]);
});

test('given a Actions setting GitHub answers 403, when sync runs, then the reason says it could not be read', async () => {
  const { branchRules } = await syncing({
    'rameezk/forge': {
      ...PROTECTED,
      actions: { status: 403, body: { message: 'Resource not accessible by integration' } },
    },
  });

  assert.deepEqual(branchRules, [
    'whether GitHub Actions can approve pull requests could not be read: GitHub answered 403: Resource not accessible by integration',
  ]);
});

test('given a repository refused at the last sync whose rules now pass, when sync runs, then it is verified again', async () => {
  const first = await syncing({ 'rameezk/forge': actionsApproving });
  assert.deepEqual(first.branchRules, ['GitHub Actions can approve pull requests']);

  const second = await syncing({ 'rameezk/forge': PROTECTED }, first.dir);

  assert.deepEqual(second.branchRules, []);
});

test('given a managed repository, when sync reads its Actions setting, then the token is narrowed to it and requests Administration: read, and no other token does', async () => {
  const { app, requests } = await syncing({ 'rameezk/forge': PROTECTED });

  const administration = app.mints.filter(({ body }) => 'administration' in (body.permissions ?? {}));
  assert.deepEqual(
    administration.map(({ body }) => body),
    [{ repositories: ['forge'], permissions: { administration: 'read' } }],
  );
  const actions = requests.find(({ pathname }) => pathname.endsWith('/actions/permissions/workflow'));
  assert.ok(actions);
  assert.ok(sentWith({ headers: { authorization: actions.authorization ?? '' } }, 'administration'));
  for (const { pathname, authorization } of requests) {
    if (pathname.endsWith('/actions/permissions/workflow')) continue;
    assert.ok(!(authorization ?? '').startsWith('bearer ghs_administration_'));
  }
});

const NEEDS_REVIEW = { approvals: 1, lastPushApproval: true };

const ruleOf = (rulesetId: number | undefined) => ({
  type: 'pull_request',
  ...(rulesetId === undefined ? {} : { ruleset_id: rulesetId }),
  parameters: {
    required_approving_review_count: NEEDS_REVIEW.approvals,
    require_last_push_approval: NEEDS_REVIEW.lastPushApproval,
  },
});

test('given a rule from a ruleset GitHub will not show, when sync runs, then the repository is refused naming the ruleset', async () => {
  const { branchRules } = await syncing({
    'rameezk/forge': { ...PROTECTED, rulesets: [], rules: { status: 200, body: [ruleOf(99)] } },
  });

  assert.deepEqual(branchRules, ['ruleset 99 could not be read: GitHub answered 404: Not Found']);
});

test('given a rule that names no ruleset, when sync runs, then the repository is refused', async () => {
  const { branchRules } = await syncing({
    'rameezk/forge': { ...PROTECTED, rulesets: [], rules: { status: 200, body: [ruleOf(undefined)] } },
  });

  assert.deepEqual(branchRules, ['a rule GitHub applies to its default branch names no ruleset to check']);
});

test('given a repository verified at the last sync whose rules have since regressed, when sync runs, then the regression is recorded', async () => {
  const first = await syncing({ 'rameezk/forge': PROTECTED });
  assert.deepEqual(first.branchRules, []);

  const second = await syncing({ 'rameezk/forge': actionsApproving }, first.dir);

  assert.deepEqual(second.branchRules, ['GitHub Actions can approve pull requests']);
});

test('given more rules than fit a page, when sync runs, then every page is read', async () => {
  const { requests, branchRules } = await syncing({
    'rameezk/forge': {
      ...PROTECTED,
      rules: { status: 200, body: [...Array.from({ length: 100 }, () => ruleOf(1)), ruleOf(2)] },
    },
  });

  assert.deepEqual(branchRules, ['ruleset 2 could not be read: GitHub answered 404: Not Found']);
  assert.equal(requests.filter(({ pathname }) => pathname.endsWith('/rules/branches/main')).length, 2);
});

test('given a ruleset name and an error message carrying control characters and a long tail, when sync runs, then they are stripped and capped in the stored reason', async () => {
  const noisy = `bad\nname${'x'.repeat(500)}`;
  const { branchRules } = await syncing({
    'rameezk/forge': {
      ...PROTECTED,
      rulesets: [{ id: 1, name: noisy, bypass: 'always', pullRequest: { approvals: 1, lastPushApproval: true } }],
      actions: { status: 403, body: { message: noisy } },
    },
  });

  assert.equal(branchRules?.length, 2);
  for (const reason of branchRules ?? []) {
    assert.doesNotMatch(reason, /\n/);
    assert.ok(reason.length < 400);
  }
});

test('given GitHub listing rules without end, when sync runs, then the repository is refused instead of the sync paging forever', async () => {
  const { branchRules } = await syncing({
    'rameezk/forge': {
      ...PROTECTED,
      rules: { status: 200, body: Array.from({ length: 3100 }, () => ruleOf(1)) },
    },
  });

  assert.deepEqual(branchRules, ['its default branch rules could not be read: GitHub listed 3000 rules or more']);
});
