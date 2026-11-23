import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../src/index.ts';
test('given a store file whose frontier predates last errors, when the store is opened, then the stale snapshot is dropped and a repository that has never been polled can record when and why it failed', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'forge-store-')), 'forge.db');
  Store.open(path).close();
  const old = new DatabaseSync(path);
  old.exec(`
    DROP TABLE frontier_tickets;
    DROP TABLE frontier_repositories;
    CREATE TABLE frontier_repositories (
      repository TEXT PRIMARY KEY,
      github     TEXT NOT NULL,
      polled_at  TEXT NOT NULL
    ) STRICT;
    CREATE TABLE frontier_tickets (
      repository    TEXT NOT NULL REFERENCES frontier_repositories (repository) ON DELETE CASCADE,
      number        INTEGER NOT NULL,
      title         TEXT NOT NULL,
      url           TEXT NOT NULL,
      parent_number INTEGER,
      parent_title  TEXT,
      created_at    TEXT NOT NULL,
      PRIMARY KEY (repository, number)
    ) STRICT;
    INSERT INTO frontier_repositories VALUES ('forge', 'rameezk/forge', '2026-09-29T08:00:00.000Z');
  `);
  old.close();

  const store = Store.open(path);
  try {
    const failedAt = '2026-09-29T08:20:00.000Z';
    store.recordFrontierError({ repository: 'fresh', github: 'rameezk/fresh', message: 'GitHub token missing', failedAt });
    assert.deepEqual(store.listFrontier(), [
      { repository: 'fresh', github: 'rameezk/fresh', polledAt: null, lastError: { message: 'GitHub token missing', failedAt }, branchRules: null, tickets: [], closed: [], requests: [] },
    ]);
  } finally {
    store.close();
  }
});

test('given a store file whose frontier snapshot predates queued tickets, when the store is opened, then the stale snapshot is dropped and a queued ticket labelled forge:ready can be stored', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'forge-store-')), 'forge.db');
  Store.open(path).close();
  const old = new DatabaseSync(path);
  old.exec(`
    DROP TABLE frontier_tickets;
    CREATE TABLE frontier_tickets (
      repository    TEXT NOT NULL REFERENCES frontier_repositories (repository) ON DELETE CASCADE,
      number        INTEGER NOT NULL,
      title         TEXT NOT NULL,
      url           TEXT NOT NULL,
      parent_number INTEGER,
      parent_title  TEXT,
      created_at    TEXT NOT NULL,
      PRIMARY KEY (repository, number)
    ) STRICT;
    INSERT INTO frontier_repositories (repository, github, polled_at, last_error, failed_at) VALUES ('forge', 'rameezk/forge', '2026-09-29T08:00:00.000Z', NULL, NULL);
    INSERT INTO frontier_tickets VALUES ('forge', 56, 'Stale', 'https://github.com/rameezk/forge/issues/56', NULL, NULL, '2026-09-28T10:07:58Z');
  `);
  old.close();

  const store = Store.open(path);
  try {
    assert.deepEqual(store.listFrontier(), []);
    const queued = {
      number: 64,
      title: 'Pinned host key and just ssh',
      url: 'https://github.com/rameezk/forge/issues/64',
      parent: null,
      createdAt: '2026-09-28T11:32:31Z',
      forgeReady: true,
      blocked: true,
      forHuman: false,
      blockedBy: [],
    };
    store.replaceFrontier({ repository: 'forge', github: 'rameezk/forge', polledAt: '2026-09-29T08:20:00.000Z', closed: [], requests: [], tickets: [queued] });
    assert.deepEqual(store.listFrontier()[0]?.tickets, [queued]);
  } finally {
    store.close();
  }
});

test('given a store file whose frontier snapshot predates spec URLs, when the store is opened, then the stale snapshot is dropped and a ticket with a spec URL can be stored', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'forge-store-')), 'forge.db');
  Store.open(path).close();
  const old = new DatabaseSync(path);
  old.exec(`
    DROP TABLE frontier_tickets;
    CREATE TABLE frontier_tickets (
      repository    TEXT NOT NULL REFERENCES frontier_repositories (repository) ON DELETE CASCADE,
      number        INTEGER NOT NULL,
      title         TEXT NOT NULL,
      url           TEXT NOT NULL,
      parent_number INTEGER,
      parent_title  TEXT,
      created_at    TEXT NOT NULL,
      forge_ready   INTEGER NOT NULL,
      blocked       INTEGER NOT NULL,
      PRIMARY KEY (repository, number)
    ) STRICT;
    INSERT INTO frontier_repositories (repository, github, polled_at, last_error, failed_at) VALUES ('forge', 'rameezk/forge', '2026-09-29T08:00:00.000Z', NULL, NULL);
    INSERT INTO frontier_tickets VALUES ('forge', 56, 'Stale', 'https://github.com/rameezk/forge/issues/56', NULL, NULL, '2026-09-28T10:07:58Z', 0, 0);
  `);
  old.close();

  const store = Store.open(path);
  try {
    assert.deepEqual(store.listFrontier(), []);
    const specced = {
      number: 64,
      title: 'Pinned host key and just ssh',
      url: 'https://github.com/rameezk/forge/issues/64',
      parent: { number: 54, title: 'Frontier discovery', url: 'https://github.com/rameezk/forge/issues/54' },
      createdAt: '2026-09-28T11:32:31Z',
      forgeReady: true,
      blocked: true,
      forHuman: false,
      blockedBy: [],
    };
    store.replaceFrontier({ repository: 'forge', github: 'rameezk/forge', polledAt: '2026-09-29T08:20:00.000Z', closed: [], requests: [], tickets: [specced] });
    assert.deepEqual(store.listFrontier()[0]?.tickets, [specced]);
  } finally {
    store.close();
  }
});


test('given a repository with stored requests, when its frontier is replaced, then only the new requests remain', () => {
  const store = Store.open(':memory:');
  try {
    const request = (number: number) => ({ number, title: `Request ${number}`, url: `https://github.com/rameezk/forge/issues/${number}`, createdAt: '2026-10-01T06:17:03Z' });
    const polled = (requests: ReturnType<typeof request>[]) => ({ repository: 'forge', github: 'rameezk/forge', polledAt: '2026-10-01T07:00:00.000Z', tickets: [], closed: [], requests });

    store.replaceFrontier(polled([request(1), request(2)]));
    store.replaceFrontier(polled([request(2), request(3)]));

    assert.deepEqual(store.listFrontier()[0]?.requests, [request(2), request(3)]);
  } finally {
    store.close();
  }
});


test('given a store file whose frontier predates branch rules, when the store is opened, then the stale snapshot is dropped and a repository records whether its rules failed', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'forge-store-')), 'forge.db');
  Store.open(path).close();
  const old = new DatabaseSync(path);
  old.exec(`
    DROP TABLE frontier_repositories;
    CREATE TABLE frontier_repositories (
      repository TEXT PRIMARY KEY,
      github     TEXT NOT NULL,
      polled_at  TEXT,
      last_error TEXT,
      failed_at  TEXT
    ) STRICT;
    INSERT INTO frontier_repositories VALUES ('forge', 'rameezk/forge', '2026-09-29T08:00:00.000Z', NULL, NULL);
  `);
  old.close();

  const store = Store.open(path);
  try {
    assert.deepEqual(store.listFrontier(), []);
    store.recordBranchRules({ repository: 'forge', github: 'rameezk/forge', failures: ['GitHub Actions can approve pull requests'] });
    assert.deepEqual(store.listFrontier()[0]?.branchRules, ['GitHub Actions can approve pull requests']);
    store.recordBranchRules({ repository: 'forge', github: 'rameezk/forge', failures: [] });
    assert.deepEqual(store.listFrontier()[0]?.branchRules, []);
  } finally {
    store.close();
  }
});

test('given repositories with a failed poll, failing branch rules and neither, when the repository problems are listed, then only the failing ones appear, by repository', () => {
  const store = Store.open(':memory:');
  try {
    for (const [repository, github] of [['forge', 'rameezk/forge'], ['dotfiles', 'rameezk/dotfiles'], ['healthy', 'rameezk/healthy']] as const) {
      store.replaceFrontier({ repository, github, polledAt: '2026-09-29T08:10:00.000Z', closed: [], requests: [], tickets: [] });
    }
    store.recordFrontierError({ repository: 'forge', github: 'rameezk/forge', message: 'GitHub answered 401', failedAt: '2026-09-29T08:20:00.000Z' });
    store.recordBranchRules({ repository: 'dotfiles', github: 'rameezk/dotfiles', failures: ['no review'] });
    store.recordBranchRules({ repository: 'healthy', github: 'rameezk/healthy', failures: [] });

    assert.deepEqual(store.listRepositoryProblems(), [
      { repository: 'dotfiles', github: 'rameezk/dotfiles', lastError: null, branchRules: ['no review'] },
      { repository: 'forge', github: 'rameezk/forge', lastError: { message: 'GitHub answered 401', failedAt: '2026-09-29T08:20:00.000Z' }, branchRules: null },
    ]);
  } finally {
    store.close();
  }
});


