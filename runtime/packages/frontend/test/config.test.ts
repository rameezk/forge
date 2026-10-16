import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveServeConfig } from '../src/index.ts';

test('given state dir, host and port, when resolved, then they are used', () => {
  assert.deepEqual(
    resolveServeConfig({
      FORGE_STATE_DIR: '/var/lib/forge',
      FORGE_FRONTEND_HOST: '127.0.0.1',
      FORGE_FRONTEND_PORT: '7787',
    }),
    { stateDir: '/var/lib/forge', hostname: '127.0.0.1', port: 7787, timeZone: 'UTC' },
  );
});

test('given no host or port, when resolved, then it binds loopback on the default port', () => {
  const config = resolveServeConfig({ FORGE_STATE_DIR: '/s' });

  assert.equal(config.hostname, '127.0.0.1');
  assert.equal(config.port, 7787);
});

test('given no state dir, when resolved, then it throws', () => {
  assert.throws(() => resolveServeConfig({}), /FORGE_STATE_DIR/);
});

test('given a non-numeric port, when resolved, then it throws', () => {
  assert.throws(
    () => resolveServeConfig({ FORGE_STATE_DIR: '/s', FORGE_FRONTEND_PORT: 'nope' }),
    /FORGE_FRONTEND_PORT/,
  );
});

test('given an out-of-range port, when resolved, then it throws', () => {
  assert.throws(
    () => resolveServeConfig({ FORGE_STATE_DIR: '/s', FORGE_FRONTEND_PORT: '70000' }),
    /FORGE_FRONTEND_PORT/,
  );
});

test('given no display time zone, when resolved, then it is UTC', () => {
  assert.equal(resolveServeConfig({ FORGE_STATE_DIR: '/s' }).timeZone, 'UTC');
});

test('given a display time zone, when resolved, then it is used', () => {
  assert.equal(
    resolveServeConfig({ FORGE_STATE_DIR: '/s', FORGE_DASHBOARD_TIME_ZONE: 'Africa/Johannesburg' }).timeZone,
    'Africa/Johannesburg',
  );
});

test('given an invalid display time zone, when resolved, then it throws', () => {
  assert.throws(
    () => resolveServeConfig({ FORGE_STATE_DIR: '/s', FORGE_DASHBOARD_TIME_ZONE: 'Mars/Olympus' }),
    /FORGE_DASHBOARD_TIME_ZONE.*Mars\/Olympus/,
  );
});
