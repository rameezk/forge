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
    { stateDir: '/var/lib/forge', socketPath: '/run/forge-frontend/dashboard.sock', maxConcurrent: 3, maxOpenPullRequests: 5, timeZone: 'UTC', deployStatusFile: null },
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

test('given a review limit, when resolved, then it is used, and null turns it off', () => {
  const base = { FORGE_STATE_DIR: '/s', FORGE_FRONTEND_SOCKET: '/s.sock' };
  assert.equal(resolveServeConfig({ ...base, FORGE_MAX_OPEN_PULL_REQUESTS: '3' }).maxOpenPullRequests, 3);
  assert.equal(resolveServeConfig({ ...base, FORGE_MAX_OPEN_PULL_REQUESTS: 'null' }).maxOpenPullRequests, null);
});

test('given no review limit, when resolved, then it defaults to 5', () => {
  assert.equal(resolveServeConfig({ FORGE_STATE_DIR: '/s', FORGE_FRONTEND_SOCKET: '/s.sock' }).maxOpenPullRequests, 5);
});

test('given a review limit that is not a positive integer or null, when resolved, then it throws', () => {
  for (const value of ['nope', '0', '-1', '1.5', '']) {
    assert.throws(
      () => resolveServeConfig({ FORGE_STATE_DIR: '/s', FORGE_FRONTEND_SOCKET: '/s.sock', FORGE_MAX_OPEN_PULL_REQUESTS: value }),
      /FORGE_MAX_OPEN_PULL_REQUESTS/,
    );
  }
});

test('given a deploy status file, when resolved, then it is used', () => {
  const config = resolveServeConfig({
    FORGE_STATE_DIR: '/s',
    FORGE_FRONTEND_SOCKET: '/run/d.sock',
    FORGE_PULL_DEPLOY_STATUS_FILE: '/var/lib/forge-pull-deploy/status.json',
  });
  assert.equal(config.deployStatusFile, '/var/lib/forge-pull-deploy/status.json');
});

test('given a deploy status file that is not an absolute path, when resolved, then it throws naming FORGE_PULL_DEPLOY_STATUS_FILE', () => {
  assert.throws(
    () => resolveServeConfig({ FORGE_STATE_DIR: '/s', FORGE_FRONTEND_SOCKET: '/run/d.sock', FORGE_PULL_DEPLOY_STATUS_FILE: 'status.json' }),
    /FORGE_PULL_DEPLOY_STATUS_FILE/,
  );
});
