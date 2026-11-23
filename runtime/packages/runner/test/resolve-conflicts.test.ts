import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/resolve-conflicts-main.ts';
import { CONFLICT_INSTRUCTION } from '../src/harness.ts';
import { textOf } from '../../frontend/test/html.ts';
import { tokenFor } from '../../shared/test/fixtures/fake-github-app.ts';
import { alive, git, DEFAULT_RESOURCE_NOTE, assertRepositoryNeutralCheckRule } from './helpers.ts';
import { PULL_REQUEST_URL, type Origin, originWhere, checkRun, resolve, mergeAndPush } from './resolve-conflicts-driver.ts';

test('given a pull request GitHub reports as conflicting whose branch merges the default branch cleanly, when forge-resolve-conflicts runs, then it ends ok without starting the harness, and nothing is pushed', async () => {
  const origin = originWhere('merges cleanly');
  const { code, pi, runs, resolutions } = await resolve({ origin, mergeable: ['CONFLICTING'] });

  assert.equal(code, 0);
  assert.equal(pi, null);
  assert.deepEqual(runs, []);
  assert.deepEqual(resolutions.map(({ state }) => state), ['done']);
  assert.equal(git(origin.path, 'rev-parse', 'feature'), origin.featureTip);
});

test('given a branch that conflicts with the default branch, when forge-resolve-conflicts runs, then the harness is told to re-run only infrastructure failures of its own pull request, at most twice, and never to dispatch or disable anything in Actions or re-trigger CI with an empty commit', async () => {
  const { pi } = await resolve({ origin: originWhere('conflicts'), worker: mergeAndPush });

  assert.ok(pi);
  const instruction = pi.argv.filter((_, index) => pi.argv[index - 1] === '--append-system-prompt').join('\n');
  assert.match(instruction, /Re-run only a failed run on the head of the pull request you work on/);
  assert.match(instruction, /Re-run the same run at most twice/);
  assert.match(instruction, /Never re-run a failing test or step, flaky or not: fix it/);
  assert.match(instruction, /Never dispatch, disable, enable or delete anything in Actions/);
  assert.match(instruction, /Never re-trigger CI with an empty commit or by closing and reopening the pull request/);
});

test('given a branch that conflicts with the default branch in two files, when forge-resolve-conflicts runs, then the worker is told the pull request, the default branch, the sha to merge and both files, in a prompt the transcript shows', async () => {
  const origin = originWhere('conflicts');
  const { pi, transcript, runs } = await resolve({ origin, worker: mergeAndPush });

  assert.ok(pi);
  const prompt = pi.argv.at(-1) ?? '';
  assert.match(prompt, new RegExp(`^/skill:git-pr-resolve-conflicts ${PULL_REQUEST_URL}\\n`));
  assert.match(prompt, /pull request #143/);
  assert.match(prompt, /default branch main/);
  assert.ok(prompt.includes(origin.mainTip));
  assert.match(prompt, /^- a\.txt$/m);
  assert.match(prompt, /^- b\.txt$/m);
  assert.equal(runs.length, 1);
  assert.ok(transcript.includes(origin.mainTip));
  assert.ok(transcript.includes('a.txt'));
  const instruction = pi.argv.filter((_, index) => pi.argv[index - 1] === '--append-system-prompt').join('\n');
  assert.ok(instruction.includes(CONFLICT_INSTRUCTION));
  assertRepositoryNeutralCheckRule(instruction);
  assert.ok(!instruction.includes(origin.mainTip));
  assert.doesNotMatch(instruction, /a\.txt|b\.txt|pull request #143/);
});

test('given a conflicting pull request, when forge-resolve-conflicts runs, then the trial merge, the worker and the check after it each clone the repository in full, without a partial-clone filter', async () => {
  const { clones, pi } = await resolve({ worker: mergeAndPush });

  assert.equal(clones.length, 3);
  for (const clone of clones) {
    assert.doesNotMatch(clone, /--filter/);
  }
  assert.ok(pi);
  assert.throws(() => git(realpathSync(pi.cwd), 'config', 'remote.origin.partialclonefilter'));
});

test('given a conflicting pull request, when the worker runs, then its git environment uses the zdiff3 conflict style', async () => {
  const { pi } = await resolve({ worker: mergeAndPush });

  assert.ok(pi);
  const config = Object.entries(pi.env).filter(([key]) => key.startsWith('GIT_CONFIG_KEY_'));
  const style = config.find(([, key]) => key === 'merge.conflictStyle');
  assert.ok(style);
  assert.equal(pi.env[style[0].replace('KEY', 'VALUE')], 'zdiff3');
});

const pushEmptyCommit = (origin: Origin): string =>
  `git commit --quiet --allow-empty -m unrelated && git push --quiet ${origin.path} HEAD:feature`;

const moveMainOnThenMerge = (origin: Origin): string =>
  `printf moved > ${origin.path}/a.txt && git -C ${origin.path} -c user.name=T -c user.email=t@example.com commit --quiet --all -m moved && ${mergeAndPush(origin)}`;

test('given a worker that merges the given sha and pushes, when the run ends, then the conflict resolution ends ok and the branch holds the sha', async () => {
  const origin = originWhere('conflicts');
  const { code, resolutions, runs } = await resolve({ origin, worker: mergeAndPush });

  assert.equal(code, 0);
  assert.deepEqual(resolutions.map(({ state, reason }) => ({ state, reason })), [{ state: 'done', reason: null }]);
  assert.equal(resolutions[0]?.runId, runs[0]?.id);
  assert.equal(git(origin.path, 'merge-base', '--is-ancestor', origin.mainTip, 'feature'), '');
});

test('given a worker that ends successfully without merging the given sha, when the run ends, then the conflict resolution fails, recording that the sha was not merged', async () => {
  const origin = originWhere('conflicts');
  const { code, resolutions, requests } = await resolve({ origin, worker: pushEmptyCommit });

  assert.equal(code, 1);
  assert.deepEqual(resolutions.map(({ state, reason }) => ({ state, reason })), [{ state: 'failed', reason: 'not-merged' }]);
  assert.ok(resolutions[0]?.detail?.includes(origin.mainTip));
  assert.equal(requests.some((query) => query.includes('mutation')), false);
});

test('given a worker that pushes but leaves the pull request conflicting with the given sha, when the run ends, then the conflict resolution fails, recording that the pull request still conflicts', async () => {
  const origin = originWhere('conflicts');
  const { code, resolutions } = await resolve({ origin, worker: mergeAndPush, mergeable: ['CONFLICTING'] });

  assert.equal(code, 1);
  assert.deepEqual(resolutions.map(({ state, reason }) => ({ state, reason })), [{ state: 'failed', reason: 'still-conflicting' }]);
  assert.ok(resolutions[0]?.detail?.includes(origin.mainTip));
});

test('given a worker that merges the given sha and leaves every required check green, when the run ends, then the conflict resolution ends ok', async () => {
  const origin = originWhere('conflicts');
  const { code, resolutions } = await resolve({
    origin,
    worker: mergeAndPush,
    checks: [checkRun('build', 'SUCCESS'), checkRun('lint', 'SKIPPED')],
  });

  assert.equal(code, 0);
  assert.deepEqual(resolutions.map(({ state, reason }) => ({ state, reason })), [{ state: 'done', reason: null }]);
});

test('given a worker that merges the given sha but leaves a required check red, when the run ends, then the conflict resolution fails, naming that check', async () => {
  const origin = originWhere('conflicts');
  const { code, resolutions, runsList } = await resolve({
    origin,
    worker: mergeAndPush,
    checks: [checkRun('build', 'SUCCESS'), checkRun('unit tests', 'FAILURE')],
  });

  assert.equal(code, 1);
  assert.deepEqual(resolutions.map(({ state, reason, detail }) => ({ state, reason, detail })), [
    { state: 'failed', reason: 'check-failed', detail: 'unit tests' },
  ]);
  assert.match(textOf(runsList), /Required check failed: unit tests/);
});

test('given a worker that merges the given sha and ends while a required check is still pending, when the run ends, then the conflict resolution fails, naming the pending check', async () => {
  const origin = originWhere('conflicts');
  const { code, resolutions, runsList } = await resolve({
    origin,
    worker: mergeAndPush,
    checks: [checkRun('build', 'SUCCESS'), checkRun('nixos vm', null)],
  });

  assert.equal(code, 1);
  assert.deepEqual(resolutions.map(({ state, reason, detail }) => ({ state, reason, detail })), [
    { state: 'failed', reason: 'check-pending', detail: 'nixos vm' },
  ]);
  assert.match(textOf(runsList), /Required check pending: nixos vm/);
});

test('given required checks that are green and a red check that is not required, when the run ends, then the conflict resolution ends ok', async () => {
  const origin = originWhere('conflicts');
  const { code, resolutions } = await resolve({
    origin,
    worker: mergeAndPush,
    checks: [checkRun('build', 'SUCCESS'), checkRun('coverage', 'FAILURE', false)],
  });

  assert.equal(code, 0);
  assert.deepEqual(resolutions.map(({ state }) => state), ['done']);
});

test('given a repository with no required checks, when a conflict resolution merges the given sha and the pull request no longer conflicts, then it ends ok', async () => {
  const origin = originWhere('conflicts');
  const { code, resolutions } = await resolve({ origin, worker: mergeAndPush, checks: null });

  assert.equal(code, 0);
  assert.deepEqual(resolutions.map(({ state }) => state), ['done']);
});

test('given GitHub still reports the pull request as conflicting right after the push, then not conflicting once it has recomputed, when the run ends, then the conflict resolution waits and ends ok', async () => {
  const origin = originWhere('conflicts');
  const { code, resolutions, pauses } = await resolve({
    origin,
    worker: mergeAndPush,
    mergeable: ['CONFLICTING', 'CONFLICTING', 'UNKNOWN', 'MERGEABLE'],
  });

  assert.equal(code, 0);
  assert.deepEqual(resolutions.map(({ state }) => state), ['done']);
  assert.equal(pauses.length, 2);
});

test('given GitHub never stops reporting UNKNOWN, when the run ends, then the conflict resolution fails saying GitHub did not say', async () => {
  const origin = originWhere('conflicts');
  const { code, resolutions } = await resolve({ origin, worker: mergeAndPush, mergeable: ['UNKNOWN'] });

  assert.equal(code, 1);
  assert.deepEqual(resolutions.map(({ state, reason }) => ({ state, reason })), [{ state: 'failed', reason: 'still-conflicting' }]);
  assert.match(resolutions[0]?.detail ?? '', /did not say/);
});

test('given the default branch gains a conflicting commit while the conflict resolution runs, and the worker merges the sha it was given, when the run ends, then the conflict resolution ends ok', async () => {
  const origin = originWhere('conflicts');
  const { code, resolutions } = await resolve({ origin, worker: moveMainOnThenMerge });

  assert.equal(code, 0);
  assert.deepEqual(resolutions.map(({ state }) => state), ['done']);
  assert.notEqual(git(origin.path, 'rev-parse', 'main'), origin.mainTip);
});

test('given a harness that fails, when the conflict resolution ends, then it ends in error and the pull request is left untouched', async () => {
  const { code, resolutions, runs, requests } = await resolve({ harnessEnv: { FAKE_PI_EXIT: '1' } });

  assert.equal(code, 1);
  assert.deepEqual(resolutions.map(({ state }) => state), ['failed']);
  assert.equal(runs[0]?.status, 'error');
  assert.equal(requests.some((query) => query.includes('mutation')), false);
});

test('given the worker checkout cannot be cloned after the trial merge found conflicts, when forge-resolve-conflicts runs, then the conflict resolution is a failed start with no run and the harness never starts', async () => {
  const { code, resolutions, pi } = await resolve({ failingClone: 2 });

  assert.equal(code, 1);
  assert.deepEqual(
    resolutions.map(({ runId, state, reason, failedStarts }) => ({ runId, state, reason, failedStarts })),
    [{ runId: null, state: 'failed', reason: 'not-started', failedStarts: 1 }],
  );
  assert.equal(pi, null);
});

test('given a conflict resolution whose trial merge never finishes, when forge-resolve-conflicts runs, then it ends failed as errored once the setup timeout passes, naming the limit, kills the merge, starts no worker and leaves the pull request untouched', async () => {
  const { code, resolutions, runs, pi, requests, hungChild } = await resolve({
    hangingTrialMerge: true,
    setupTimeoutSeconds: 1,
  });

  assert.equal(code, 1);
  assert.deepEqual(
    resolutions.map(({ state, reason }) => ({ state, reason })),
    [{ state: 'failed', reason: 'errored' }],
  );
  assert.equal(
    resolutions[0]?.detail,
    'the trial merge did not finish within 1s, stuck in the merge',
  );
  assert.deepEqual(runs, []);
  assert.equal(pi, null);
  assert.equal(requests.some((query) => query.includes('mutation')), false);
  assert.notEqual(hungChild, null);
  assert.equal(alive(hungChild as number), false);
});

test('given a conflict resolution that ran, when the runs list is rendered, then its run shows against its pull request', async () => {
  const { runsList } = await resolve({ worker: mergeAndPush });

  const row = /<tr[^>]*data-run="[^"]*"[^>]*>[\s\S]*?<\/tr>/.exec(runsList)?.[0] ?? '';
  assert.match(textOf(row), /forge PR #143/);
});

test('given a conflict resolution that inspects the trial merge, runs the worker and checks the result, when it ends, then every workload token minted for it has been revoked', async () => {
  const origin = originWhere('conflicts');
  const { app, resolutions } = await resolve({ origin, worker: mergeAndPush });

  assert.equal(resolutions[0]?.state, 'done');
  const minted = app.mints
    .filter((mint) => mint.kind === 'workload')
    .map((mint, index) => tokenFor('workload', mint.repository, index + 1));
  assert.ok(minted.length >= 2);
  assert.deepEqual(
    app.revocations.filter((token) => token.startsWith('ghs_workload_')).sort(),
    [...minted].sort(),
  );
});

test('given a branch that conflicts with the default branch, when forge-resolve-conflicts runs, then the prompt ends with the resource note, which states the shared memory limit and CPU count and never says budget', async () => {
  const { pi } = await resolve({ origin: originWhere('conflicts'), worker: mergeAndPush });

  const prompt = pi?.argv.at(-1) ?? '';
  assert.ok(prompt.endsWith(`\n\n${DEFAULT_RESOURCE_NOTE}`));
  assert.doesNotMatch(DEFAULT_RESOURCE_NOTE, /budget/i);
});
