import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@forge/shared';
import { main as migrate } from '../src/migrate-main.ts';

test('given a state directory without forge.db, when forge-migrate runs, then forge.db exists and a read-only store reads it', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'forge-migrate-'));

  migrate({ FORGE_STATE_DIR: stateDir });

  assert.equal(existsSync(join(stateDir, 'forge.db')), true);
  const store = Store.openReadOnly(join(stateDir, 'forge.db'));
  assert.equal(store.getRun('absent'), undefined);
  store.close();
});

test('given no state directory, when forge-migrate runs, then it fails naming FORGE_STATE_DIR', () => {
  assert.throws(() => migrate({}), /FORGE_STATE_DIR is not set/);
});
