import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveServeConfig } from '../src/index.ts';

test('given state dir and socket, when resolved, then they are used', () => {
  assert.deepEqual(
    resolveServeConfig({
      FORGE_STATE_DIR: '/var/lib/forge',
      FORGE_FRONTEND_SOCKET: '/run/forge-frontend/dashboard.sock',
      FORGE_MAX_CONCURRENT: '3',
    }),
    { stateDir: '/var/lib/forge', socketPath: '/run/forge-frontend/dashboard.sock', maxConcurrent: 3, timeZone: 'UTC' },
  );
});

test('given no socket, when resolved, then it throws naming FORGE_FRONTEND_SOCKET', () => {
  assert.throws(() => resolveServeConfig({ FORGE_STATE_DIR: '/s' }), /FORGE_FRONTEND_SOCKET/);
});

test('given a socket that is not an absolute path, when resolved, then it throws naming FORGE_FRONTEND_SOCKET', () => {
  for (const value of ['', '7787', 'dashboard.sock']) {
    assert.throws(
      () => resolveServeConfig({ FORGE_STATE_DIR: '/s', FORGE_FRONTEND_SOCKET: value }),
      /FORGE_FRONTEND_SOCKET/,
    );
  }
});

test('given no running limit, when resolved, then it defaults to 1', () => {
  assert.equal(resolveServeConfig({ FORGE_STATE_DIR: '/s', FORGE_FRONTEND_SOCKET: '/s.sock' }).maxConcurrent, 1);
});

test('given a running limit that is not a positive integer, when resolved, then it throws', () => {
  for (const value of ['nope', '0', '-1', '1.5']) {
    assert.throws(
      () => resolveServeConfig({ FORGE_STATE_DIR: '/s', FORGE_FRONTEND_SOCKET: '/s.sock', FORGE_MAX_CONCURRENT: value }),
      /FORGE_MAX_CONCURRENT/,
    );
  }
});

test('given no state dir, when resolved, then it throws', () => {
  assert.throws(() => resolveServeConfig({}), /FORGE_STATE_DIR/);
});

test('given no display time zone, when resolved, then it is UTC', () => {
  assert.equal(resolveServeConfig({ FORGE_STATE_DIR: '/s', FORGE_FRONTEND_SOCKET: '/s.sock' }).timeZone, 'UTC');
});

test('given a display time zone, when resolved, then it is used', () => {
  assert.equal(
    resolveServeConfig({ FORGE_STATE_DIR: '/s', FORGE_FRONTEND_SOCKET: '/s.sock', FORGE_DASHBOARD_TIME_ZONE: 'Africa/Johannesburg' }).timeZone,
    'Africa/Johannesburg',
  );
});

test('given an invalid display time zone, when resolved, then it throws', () => {
  assert.throws(
    () => resolveServeConfig({ FORGE_STATE_DIR: '/s', FORGE_FRONTEND_SOCKET: '/s.sock', FORGE_DASHBOARD_TIME_ZONE: 'Mars/Olympus' }),
    /FORGE_DASHBOARD_TIME_ZONE.*Mars\/Olympus/,
  );
});
