import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type PolledFrontier, type Ticket } from '@forge/shared';
import { main } from '../src/pass-main.ts';
import { journaled, leaveOpenPullRequests, startedDispatch } from './helpers.ts';

const ticket = (github: string, number: number, overrides: Partial<Ticket> = {}): Ticket => ({
  number,
  title: `Ticket ${number}`,
  url: `https://github.com/${github}/issues/${number}`,
  parent: null,
  createdAt: `2026-09-28T10:00:${String(number % 60).padStart(2, '0')}Z`,
  forgeReady: true,
  blocked: false,
  forHuman: false,
  blockedBy: [],
  ...overrides,
});

const polled = (repository: string, github: string, tickets: Ticket[]): PolledFrontier => ({
  repository,
  github,
  polledAt: '2026-09-29T08:00:00.000Z',
  tickets,
  closed: [], requests: [],
});

interface Scenario {
  frontier: PolledFrontier[];
  maxConcurrent?: number;
  maxOpenPullRequests?: number | null;
  seed?: (store: Store) => void;
  failingUnit?: string;
  failedPolls?: string[];
  diagnosisWorker?: string;
  passes?: number;
}

const pass = async ({ frontier, maxConcurrent, maxOpenPullRequests, seed, failingUnit, failedPolls = [], diagnosisWorker, passes = 1 }: Scenario) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'forge-pass-'));
  const configPath = join(stateDir, 'runtime.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      harnesses: { pi: { command: '/bin/false' } },
      workers: {
        builder: { harness: 'pi', model: 'z-ai/glm-5', prompt: '/work-on {url}' },
        diagnoser: { harness: 'pi', model: 'z-ai/glm-5', prompt: 'Find the cause' },
      },
      ...(diagnosisWorker === undefined ? {} : { diagnosis: { worker: diagnosisWorker } }),
      repositories: {
        forge: { github: 'rameezk/forge', on: { ticket: 'builder' } },
        dotfiles: { github: 'rameezk/dotfiles', on: { ticket: 'builder' } },
        notes: { github: 'rameezk/notes' },
      },
      dispatch: {
        ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
        ...(maxOpenPullRequests === undefined ? {} : { maxOpenPullRequests }),
      },
    }),
  );
  const record = join(stateDir, 'systemctl-calls');
  const systemctl = join(stateDir, 'systemctl');
  writeFileSync(
    systemctl,
    `#!/bin/sh\necho "$*" >> "${record}"\ncase "$5" in $FAKE_SYSTEMCTL_FAILING) exit 1 ;; esac\n`,
  );
  chmodSync(systemctl, 0o755);

  const store = Store.open(join(stateDir, 'forge.db'));
  try {
    for (const repository of frontier) store.replaceFrontier(repository);
    for (const repository of failedPolls) {
      store.recordFrontierError({ repository, github: `rameezk/${repository}`, message: 'GitHub answered 502', failedAt: '2026-09-29T08:05:00.000Z' });
    }
    seed?.(store);
  } finally {
    store.close();
  }

  const { result: code, journal } = await journaled(async () => {
    let last = 0;
    for (let index = 0; index < passes; index += 1) {
      last = await main([], {
        FORGE_RUNTIME_CONFIG: configPath,
        FORGE_STATE_DIR: stateDir,
        FORGE_SYSTEMCTL: systemctl,
        ...(failingUnit === undefined ? {} : { FAKE_SYSTEMCTL_FAILING: failingUnit }),
      });
    }
    return last;
  });
  const started = existsSync(record)
    ? readFileSync(record, 'utf8').trim().split('\n')
    : [];
  return { code, journal, started };
};

test('given a frontier ticket labelled forge:ready, a frontier ticket without it, a queued ticket still blocked, and a labelled ticket in a repository with no worker, when the pass runs, then only the labelled frontier ticket is dispatched, by starting its forge-dispatch unit without waiting for it', async () => {
  const { code, started, journal } = await pass({
    frontier: [
      polled('forge', 'rameezk/forge', [
        ticket('rameezk/forge', 113),
        ticket('rameezk/forge', 114, { forgeReady: false }),
        ticket('rameezk/forge', 115, { blocked: true }),
      ]),
      polled('notes', 'rameezk/notes', [ticket('rameezk/notes', 7)]),
    ],
  });

  assert.equal(code, 0);
  assert.deepEqual(started, ['start --no-block --no-ask-password -- forge-dispatch@forge:113.service']);
  assert.match(journal, /forge#113: started forge-dispatch@forge:113\.service/);
});

test('given an unblocked ready-for-human ticket labelled forge:ready beside a frontier ticket labelled forge:ready, when the pass runs, then only the agent ticket is dispatched', async () => {
  const { started } = await pass({
    frontier: [
      polled('forge', 'rameezk/forge', [
        ticket('rameezk/forge', 113, { forHuman: true }),
        ticket('rameezk/forge', 114),
      ]),
    ],
  });

  assert.deepEqual(started, ['start --no-block --no-ask-password -- forge-dispatch@forge:114.service']);
});

test('given maxConcurrent = 1 and two dispatchable tickets, when the pass runs, then only the older is dispatched and the other waits; while the first runs a later pass dispatches nothing, even though the snapshot predates its claim; and once it finishes the next pass dispatches the other', async () => {
  const forge = (tickets: Ticket[]) => polled('forge', 'rameezk/forge', tickets);
  const dotfiles = polled('dotfiles', 'rameezk/dotfiles', [ticket('rameezk/dotfiles', 5, { createdAt: '2026-09-28T11:00:00Z' })]);
  const older = ticket('rameezk/forge', 113, { createdAt: '2026-09-28T10:00:00Z' });

  const first = await pass({ maxConcurrent: 1, frontier: [forge([older]), dotfiles] });
  assert.deepEqual(first.started, ['start --no-block --no-ask-password -- forge-dispatch@forge:113.service']);
  assert.match(first.journal, /dotfiles#5: waits, 1 of 1 workloads would be running/);

  const running = await pass({
    frontier: [forge([older]), dotfiles],
    seed: (store) => startedDispatch(store, 'forge', 113, 'run-113', new Date().toISOString()),
  });
  assert.deepEqual(running.started, []);

  const finished = await pass({
    frontier: [forge([]), dotfiles],
    seed: (store) => {
      const at = new Date().toISOString();
      store.endDispatch(startedDispatch(store, 'forge', 113, 'run-113', at), { state: 'done', pullRequest: { number: 143, url: 'https://github.com/rameezk/forge/pull/143' } }, at);
    },
  });
  assert.deepEqual(finished.started, ['start --no-block --no-ask-password -- forge-dispatch@dotfiles:5.service']);
});

test('given maxConcurrent = 3, a manual dispatch still running, a stale dispatch, and two dispatchable tickets from the same repository, when the pass runs, then both tickets are dispatched to run in parallel', async () => {
  const { started } = await pass({
    maxConcurrent: 3,
    frontier: [polled('forge', 'rameezk/forge', [ticket('rameezk/forge', 113), ticket('rameezk/forge', 114)])],
    seed: (store) => {
      startedDispatch(store, 'dotfiles', 9, 'run-9', new Date().toISOString());
      startedDispatch(store, 'dotfiles', 10, 'run-10', '2026-09-01T09:00:00.000Z');
    },
  });

  assert.deepEqual(started, [
    'start --no-block --no-ask-password -- forge-dispatch@forge:113.service',
    'start --no-block --no-ask-password -- forge-dispatch@forge:114.service',
  ]);
});

test('given systemd refuses to start one of two dispatchable tickets, when the pass runs, then the other is still dispatched, the refusal is named, and the pass fails', async () => {
  const { code, started, journal } = await pass({
    maxConcurrent: 2,
    failingUnit: 'forge-dispatch@forge:113.service',
    frontier: [polled('forge', 'rameezk/forge', [ticket('rameezk/forge', 113), ticket('rameezk/forge', 114)])],
  });

  assert.equal(code, 1);
  assert.deepEqual(started, [
    'start --no-block --no-ask-password -- forge-dispatch@forge:113.service',
    'start --no-block --no-ask-password -- forge-dispatch@forge:114.service',
  ]);
  assert.match(journal, /forge#113: could not start forge-dispatch@forge:113\.service: Command failed/);
  assert.match(journal, /forge#114: started forge-dispatch@forge:114\.service/);
});

test('given maxConcurrent = 1 and an older forge:ready ticket in a repository whose last poll failed, when the pass runs, then its stale snapshot is passed over and the newer ticket from a freshly polled repository is dispatched', async () => {
  const { started } = await pass({
    maxConcurrent: 1,
    frontier: [
      polled('forge', 'rameezk/forge', [ticket('rameezk/forge', 113, { createdAt: '2026-09-28T10:00:00Z' })]),
      polled('dotfiles', 'rameezk/dotfiles', [ticket('rameezk/dotfiles', 5, { createdAt: '2026-09-28T11:00:00Z' })]),
    ],
    failedPolls: ['forge'],
  });

  assert.deepEqual(started, ['start --no-block --no-ask-password -- forge-dispatch@dotfiles:5.service']);
});

test('given maxConcurrent = 1, a revision of a pull request still running and a dispatchable ticket, when the pass runs, then nothing is dispatched and the ticket waits for the slot', async () => {
  const { started, journal } = await pass({
    maxConcurrent: 1,
    frontier: [polled('forge', 'rameezk/forge', [ticket('rameezk/forge', 113)])],
    seed: (store) => {
      const start = store.startRevision(
        { repository: 'forge', number: 143, url: 'https://github.com/rameezk/forge/pull/143' },
        [],
        'run-revision',
        new Date().toISOString(),
        1,
      );
      assert.ok('started' in start);
    },
  });

  assert.deepEqual(started, []);
  assert.match(journal, /forge#113: waits, 1 of 1 workloads would be running/);
});

const dispatchUnit = (repository: string, number: number): string =>
  `start --no-block --no-ask-password -- forge-dispatch@${repository}:${number}.service`;

test('given 5 open pull requests left by done dispatches and a forge:ready frontier ticket, when the pass runs, then no dispatch unit starts and the log says the ticket waits because 5 of 5 pull requests are open for review', async () => {
  const { started, journal } = await pass({
    maxConcurrent: 5,
    frontier: [polled('forge', 'rameezk/forge', [ticket('rameezk/forge', 113)])],
    seed: (store) => leaveOpenPullRequests(store, 'forge', 5),
  });

  assert.deepEqual(started, []);
  assert.match(journal, /forge#113: waits, 5 of 5 pull requests are open for review/);
});

test('given 3 open dispatch pull requests, 2 running dispatches, maxConcurrent 5 and two forge:ready tickets, when the pass runs, then no dispatch unit starts', async () => {
  const { started, journal } = await pass({
    maxConcurrent: 5,
    frontier: [polled('forge', 'rameezk/forge', [ticket('rameezk/forge', 113), ticket('rameezk/forge', 114)])],
    seed: (store) => {
      leaveOpenPullRequests(store, 'forge', 3);
      startedDispatch(store, 'forge', 301, 'run-301', new Date().toISOString());
      startedDispatch(store, 'forge', 302, 'run-302', new Date().toISOString());
    },
  });

  assert.deepEqual(started, []);
  assert.match(journal, /forge#113: waits, 5 of 5 pull requests are open for review/);
  assert.match(journal, /forge#114: waits, 5 of 5 pull requests are open for review/);
});

test('given 3 open dispatch pull requests, nothing running, maxConcurrent 5 and three forge:ready tickets, when the pass runs, then only the two oldest are dispatched and the third waits on the review limit', async () => {
  const { started, journal } = await pass({
    maxConcurrent: 5,
    frontier: [
      polled('forge', 'rameezk/forge', [
        ticket('rameezk/forge', 113, { createdAt: '2026-09-28T10:00:00Z' }),
        ticket('rameezk/forge', 114, { createdAt: '2026-09-28T10:01:00Z' }),
        ticket('rameezk/forge', 115, { createdAt: '2026-09-28T10:02:00Z' }),
      ]),
    ],
    seed: (store) => leaveOpenPullRequests(store, 'forge', 3),
  });

  assert.deepEqual(started, [dispatchUnit('forge', 113), dispatchUnit('forge', 114)]);
  assert.match(journal, /forge#115: waits, 5 of 5 pull requests are open for review/);
});

test('given 3 open dispatch pull requests in one repository, 2 in another and a forge:ready ticket in a third, when the pass runs, then the ticket waits', async () => {
  const { started, journal } = await pass({
    maxConcurrent: 5,
    frontier: [polled('forge', 'rameezk/forge', [ticket('rameezk/forge', 113)])],
    seed: (store) => {
      leaveOpenPullRequests(store, 'dotfiles', 3);
      leaveOpenPullRequests(store, 'notes', 2);
    },
  });

  assert.deepEqual(started, []);
  assert.match(journal, /forge#113: waits, 5 of 5 pull requests are open for review/);
});

test('given 5 dispatch pull requests of which one is merged, when the pass runs with a forge:ready ticket, then it is dispatched; and the same when one is closed', async () => {
  for (const state of ['merged', 'closed'] as const) {
    const { started } = await pass({
      maxConcurrent: 5,
      frontier: [polled('forge', 'rameezk/forge', [ticket('rameezk/forge', 113)])],
      seed: (store) => leaveOpenPullRequests(store, 'forge', 5, { 2: state }),
    });
    assert.deepEqual(started, [dispatchUnit('forge', 113)]);
  }
});

test('given no maxOpenPullRequests, 4 open dispatch pull requests, maxConcurrent 3 and two forge:ready tickets, when the pass runs, then exactly one dispatch unit starts', async () => {
  const { started, journal } = await pass({
    maxConcurrent: 3,
    frontier: [
      polled('forge', 'rameezk/forge', [
        ticket('rameezk/forge', 113, { createdAt: '2026-09-28T10:00:00Z' }),
        ticket('rameezk/forge', 114, { createdAt: '2026-09-28T10:01:00Z' }),
      ]),
    ],
    seed: (store) => leaveOpenPullRequests(store, 'forge', 4),
  });

  assert.deepEqual(started, [dispatchUnit('forge', 113)]);
  assert.match(journal, /forge#114: waits, 5 of 5 pull requests are open for review/);
});

test('given maxOpenPullRequests null and 10 open dispatch pull requests, when the pass runs with a forge:ready ticket, then it is dispatched', async () => {
  const { started } = await pass({
    maxOpenPullRequests: null,
    frontier: [polled('forge', 'rameezk/forge', [ticket('rameezk/forge', 113)])],
    seed: (store) => leaveOpenPullRequests(store, 'forge', 10),
  });

  assert.deepEqual(started, [dispatchUnit('forge', 113)]);
});

test('given maxOpenPullRequests 2 and 2 open dispatch pull requests, when the pass runs, then the ticket waits and the log names the configured limit', async () => {
  const { started, journal } = await pass({
    maxOpenPullRequests: 2,
    frontier: [polled('forge', 'rameezk/forge', [ticket('rameezk/forge', 113)])],
    seed: (store) => leaveOpenPullRequests(store, 'forge', 2),
  });

  assert.deepEqual(started, []);
  assert.match(journal, /forge#113: waits, 2 of 2 pull requests are open for review/);
});

const failedWith = (reason: 'check-failed' | 'interrupted' | 'no-pull-request') => (store: Store) => {
  const at = new Date().toISOString();
  const id = startedDispatch(store, 'forge', 31, 'failed-run', at);
  store.endDispatch(id, { state: 'failed', reason, detail: null }, at);
};

const diagnosisUnits = (started: string[]): string[] =>
  started.filter((line) => line.includes('forge-diagnose@'));

test('given a diagnosis worker and a dispatch that failed with check-failed, when the pass runs twice, then exactly one forge-diagnose unit starts for it, on its own, whatever the concurrency limit', async () => {
  const { started, journal } = await pass({
    frontier: [],
    maxConcurrent: 1,
    diagnosisWorker: 'diagnoser',
    seed: (store) => {
      failedWith('check-failed')(store);
      startedDispatch(store, 'dotfiles', 9, 'other-run', new Date().toISOString());
    },
    passes: 2,
  });

  const units = diagnosisUnits(started);
  assert.equal(units.length, 1);
  assert.match(units[0] ?? '', /^start --no-block --no-ask-password -- forge-diagnose@[0-9a-f-]{36}\.service$/);
  assert.match(journal, /forge#31: diagnosing failed-run with forge-diagnose@/);
});

test('given a diagnosis worker and a dispatch that ended interrupted, when the pass runs, then no diagnosis starts', async () => {
  const { started } = await pass({ frontier: [], diagnosisWorker: 'diagnoser', seed: failedWith('interrupted') });
  assert.deepEqual(diagnosisUnits(started), []);
});

test('given no diagnosis worker and a dispatch that failed with no-pull-request, when the pass runs, then no diagnosis starts', async () => {
  const { started } = await pass({ frontier: [], seed: failedWith('no-pull-request') });
  assert.deepEqual(diagnosisUnits(started), []);
});

test('given a diagnosis unit that cannot be started, when the pass runs again, then the pass tries again', async () => {
  const { started, code } = await pass({
    frontier: [],
    diagnosisWorker: 'diagnoser',
    seed: failedWith('check-failed'),
    failingUnit: 'forge-diagnose@*',
    passes: 2,
  });
  assert.equal(diagnosisUnits(started).length, 2);
  assert.equal(code, 1);
});
