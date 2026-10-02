import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type PolledFrontier, type Ticket } from '@forge/shared';
import { main } from '../src/pass-main.ts';
import { journaled, startedDispatch } from './helpers.ts';

const ticket = (github: string, number: number, overrides: Partial<Ticket> = {}): Ticket => ({
  number,
  title: `Ticket ${number}`,
  url: `https://github.com/${github}/issues/${number}`,
  parent: null,
  createdAt: `2026-09-28T10:00:${String(number % 60).padStart(2, '0')}Z`,
  forgeReady: true,
  blocked: false,
  ...overrides,
});

const polled = (repository: string, github: string, tickets: Ticket[]): PolledFrontier => ({
  repository,
  github,
  polledAt: '2026-09-29T08:00:00.000Z',
  tickets,
});

interface Scenario {
  frontier: PolledFrontier[];
  maxConcurrent?: number;
  seed?: (store: Store) => void;
  failingUnit?: string;
  failedPolls?: string[];
}

const pass = async ({ frontier, maxConcurrent, seed, failingUnit, failedPolls = [] }: Scenario) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'forge-pass-'));
  const configPath = join(stateDir, 'runtime.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      harnesses: { pi: { command: '/bin/false' } },
      workers: { builder: { harness: 'pi', model: 'z-ai/glm-5', prompt: '/work-on {url}' } },
      repositories: {
        forge: { github: 'rameezk/forge', worker: 'builder' },
        dotfiles: { github: 'rameezk/dotfiles', worker: 'builder' },
        notes: { github: 'rameezk/notes' },
      },
      dispatch: maxConcurrent === undefined ? {} : { maxConcurrent },
    }),
  );
  const record = join(stateDir, 'systemctl-calls');
  const systemctl = join(stateDir, 'systemctl');
  writeFileSync(
    systemctl,
    `#!/bin/sh\necho "$*" >> "${record}"\n[ "$5" != "$FAKE_SYSTEMCTL_FAILING" ]\n`,
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

  const { result: code, journal } = await journaled(() =>
    main([], {
      FORGE_RUNTIME_CONFIG: configPath,
      FORGE_STATE_DIR: stateDir,
      FORGE_SYSTEMCTL: systemctl,
      ...(failingUnit === undefined ? {} : { FAKE_SYSTEMCTL_FAILING: failingUnit }),
    }),
  );
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

test('given maxConcurrent = 1 and two dispatchable tickets, when the pass runs, then only the older is dispatched and the other waits; while the first runs a later pass dispatches nothing, even though the snapshot predates its claim; and once it finishes the next pass dispatches the other', async () => {
  const forge = (tickets: Ticket[]) => polled('forge', 'rameezk/forge', tickets);
  const dotfiles = polled('dotfiles', 'rameezk/dotfiles', [ticket('rameezk/dotfiles', 5, { createdAt: '2026-09-28T11:00:00Z' })]);
  const older = ticket('rameezk/forge', 113, { createdAt: '2026-09-28T10:00:00Z' });

  const first = await pass({ maxConcurrent: 1, frontier: [forge([older]), dotfiles] });
  assert.deepEqual(first.started, ['start --no-block --no-ask-password -- forge-dispatch@forge:113.service']);
  assert.match(first.journal, /dotfiles#5: waits, 1 of 1 dispatched workloads would be running/);

  const running = await pass({
    frontier: [forge([older]), dotfiles],
    seed: (store) => startedDispatch(store, 'forge', 113, 'run-113', new Date().toISOString()),
  });
  assert.deepEqual(running.started, []);

  const finished = await pass({
    frontier: [forge([]), dotfiles],
    seed: (store) => {
      const at = new Date().toISOString();
      store.endDispatch(startedDispatch(store, 'forge', 113, 'run-113', at), { state: 'done' }, at);
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
