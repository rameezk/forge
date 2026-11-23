import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Store } from '@forge/shared';
import type { LifecycleKind, LifecycleScenario } from './lifecycle.ts';
import { revisionLifecycle } from './revise-driver.ts';
import { conflictResolutionLifecycle } from './resolve-conflicts-driver.ts';

const PULL_REQUEST_URL = 'https://github.com/rameezk/forge/pull/143';

const PUSHED = 'b'.repeat(40);

const OTHER_PULL_REQUEST = { repository: 'forge', url: 'https://github.com/rameezk/forge/pull/99' };

const liveDispatch = (store: Store): void => {
  const start = store.startDispatch(
    { repository: 'forge', number: 113, url: 'https://github.com/rameezk/forge/issues/113' },
    'opening-run',
    new Date().toISOString(),
    10,
    null,
  );
  assert.ok('started' in start);
};

const liveRevision = (store: Store): void => {
  const start = store.startRevision(
    { repository: 'forge', number: 143, url: PULL_REQUEST_URL },
    [],
    'earlier',
    new Date().toISOString(),
    10,
  );
  assert.ok('started' in start);
};

const liveConflictResolution = (store: Store): void => {
  const start = store.startConflictResolution(
    { repository: 'forge', number: 143, url: PULL_REQUEST_URL },
    [],
    'earlier',
    new Date().toISOString(),
    10,
    { headSha: 'head-a', defaultSha: 'default-a' },
  );
  assert.ok('started' in start);
};

const livePoolFiller = (store: Store): void => {
  const start = store.startRevision(
    { ...OTHER_PULL_REQUEST, number: 99 },
    [],
    'other',
    new Date().toISOString(),
    1,
  );
  assert.ok('started' in start);
};

const refusals: [string, LifecycleScenario, RegExp][] = [
  ['closed', { closed: true }, /it is not open/],
  ['from a fork', { fromFork: true }, /its branch is on a fork/],
  [
    'with a live dispatch of the ticket that opened it',
    { seed: liveDispatch },
    /the dispatch that opened it is still running/,
  ],
  ['with a live revision', { seed: liveRevision }, /a revision of it is already running/],
  [
    'with a live conflict resolution',
    { seed: liveConflictResolution },
    /a conflict resolution of it is already running/,
  ],
  [
    'while the pool is full',
    { maxConcurrent: 1, seed: livePoolFiller },
    /1 workload is already running, the most forge\.runtime\.dispatch\.maxConcurrent allows/,
  ],
];

const kinds: LifecycleKind[] = [revisionLifecycle, conflictResolutionLifecycle];

for (const kind of kinds) {
  const prepareFailures: [string, LifecycleScenario, string][] = [
    ['a bot identity lookup that answers 401', { botLookupFails: true }, 'GitHub answered 401: Bad credentials'],
    ['a pull request head query that fails', { headQueryFails: true }, 'GitHub is down'],
    ...kind.extraPrepareFailures.map(([what, scenario]): [string, LifecycleScenario, string] => [
      what,
      scenario,
      'GitHub is down',
    ]),
  ];

  test(`given a ${kind.name} command without a repository and pull request number, when it runs, then it throws its usage`, async () => {
    await assert.rejects(
      kind.main([], {}, globalThis.fetch),
      { message: `usage: ${kind.command} <repository> <pull-request>` },
    );
  });

  for (const [what, scenario, reason] of refusals) {
    test(`given a pull request ${what}, when the ${kind.name} runs, then no workload starts, nothing is recorded, and the command says why in the ${kind.name}'s wording`, async () => {
      const { code, harnessStarted, runs, workloads, complaints } = await kind.run(scenario);

      assert.equal(code, 1);
      assert.equal(harnessStarted, false);
      assert.deepEqual(runs, []);
      assert.equal(
        workloads.every(({ state }) => state === 'running'),
        true,
      );
      assert.match(complaints, new RegExp(`^forge#143 ${kind.refusal}: `));
      assert.match(complaints, reason);
    });
  }

  for (const [what, scenario, detail] of prepareFailures) {
    test(`given ${what}, when the ${kind.name} runs, then it is a failed start with no run carrying the error, and the command exits 1`, async () => {
      const { code, thrown, harnessStarted, runs, workloads, runsList } = await kind.run(scenario);

      assert.equal(code, 1);
      assert.equal(thrown, detail);
      assert.equal(harnessStarted, false);
      assert.deepEqual(workloads, [
        { runId: null, state: 'failed', reason: 'not-started', detail, failedStarts: 1 },
      ]);
      assert.deepEqual(runs, []);
      assert.doesNotMatch(runsList, /data-run=/);
    });
  }

  test(`given a ${kind.name} that already failed to start, when preparing fails again, then there is one failed start with a count of two`, async () => {
    const { workloads } = await kind.run({
      botLookupFails: true,
      seed: kind.earlierFailedStart,
    });

    assert.deepEqual(
      workloads.map(({ reason, failedStarts }) => ({ reason, failedStarts })),
      [{ reason: 'not-started', failedStarts: 2 }],
    );
  });

  test(`given a live ${kind.name} of the pull request, when a second one fails while preparing, then the live one stays the latest and no failed start is recorded over it`, async () => {
    const { code, workloads, runs } = await kind.run({
      botLookupFails: true,
      seed: kind.livePullRequest,
    });

    assert.equal(code, 1);
    assert.deepEqual(workloads.map(({ state }) => state), ['running']);
    assert.deepEqual(runs, []);
  });

  test(`given the ${kind.name}'s work before the launch fails, when it runs, then it is a failed start with no run and the error as its detail`, async () => {
    const { code, thrown, harnessStarted, runs, workloads } = await kind.run({ beforeFails: true });

    assert.equal(code, 1);
    assert.notEqual(thrown, null);
    assert.equal(harnessStarted, false);
    assert.deepEqual(runs, []);
    assert.deepEqual(workloads, [
      { runId: null, state: 'failed', reason: 'not-started', detail: thrown, failedStarts: 1 },
    ]);
  });

  test(`given launching the worker throws, when the ${kind.name} runs, then it is a failed start with the message as detail`, async () => {
    const { code, thrown, harnessStarted, workloads } = await kind.run({ launchThrows: true });

    assert.equal(code, 1);
    assert.equal(harnessStarted, false);
    assert.notEqual(thrown, null);
    assert.deepEqual(workloads, [
      { runId: null, state: 'failed', reason: 'not-started', detail: thrown, failedStarts: 1 },
    ]);
  });

  test(`given a worker checkout whose clone never finishes, when the ${kind.name} runs, then the run ends error at the setup timeout and it fails as errored, naming the limit, with no harness started`, async () => {
    const { code, harnessStarted, runs, workloads } = await kind.run({
      hangingClone: true,
      setupTimeoutSeconds: 1,
    });

    const error = 'setup did not finish within 1s, stuck in the clone';
    assert.equal(code, 1);
    assert.equal(harnessStarted, false);
    assert.equal(runs[0]?.status, 'error');
    assert.equal(runs[0]?.error, error);
    assert.deepEqual(
      workloads.map(({ state, reason, detail }) => ({ state, reason, detail })),
      [{ state: 'failed', reason: 'errored', detail: error }],
    );
  });

  test(`given a worker that ran and a GitHub that then fails the ${kind.name}'s check, when it runs, then it is crashed with its run, not a failed start, and its pushed head is still recorded`, async () => {
    const { code, runs, workloads, pushedHeads } = await kind.run({
      checkFails: true,
      pushedHead: PUSHED,
    });

    assert.equal(code, 1);
    assert.deepEqual(
      workloads.map(({ runId, state, reason, failedStarts }) => ({ runId, state, reason, failedStarts })),
      [{ runId: runs[0]?.id, state: 'failed', reason: 'crashed', failedStarts: null }],
    );
    assert.deepEqual(pushedHeads, [PUSHED]);
  });

  test(`given a run that leaves the pull request on a new head, when the ${kind.name} ends, then it records that head as the one it pushed and exits 0`, async () => {
    const { code, runs, workloads, pushedHeads } = await kind.run({ pushedHead: PUSHED });

    assert.equal(code, 0);
    assert.deepEqual(
      workloads.map(({ runId, state, reason }) => ({ runId, state, reason })),
      [{ runId: runs[0]?.id, state: 'done', reason: null }],
    );
    assert.deepEqual(pushedHeads, [PUSHED]);
  });

  test(`given a run that leaves the pull request on the head it started with, when the ${kind.name} ends, then it records no pushed head`, async () => {
    const { pushedHeads } = await kind.run({});

    assert.deepEqual(pushedHeads, [null]);
  });

  test(`given a harness that runs past the worker's timeout, when the ${kind.name} runs, then the run ends exceeded, it fails as exceeded naming the timeout, and the command exits 1`, async () => {
    const { code, runs, workloads } = await kind.run({ exceeds: true });

    assert.equal(code, 1);
    assert.equal(runs[0]?.status, 'exceeded');
    assert.deepEqual(
      workloads.map(({ state, reason, detail }) => ({ state, reason, detail })),
      [{ state: 'failed', reason: 'exceeded', detail: 'timeout' }],
    );
  });
}
