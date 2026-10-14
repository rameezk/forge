import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withoutCredentials } from '../src/provider.ts';

test('given an environment holding the GitHub App id and key path, when credentials are stripped for host-side processes, then neither remains', () => {
  const kept = withoutCredentials({
    PATH: '/bin',
    FORGE_GITHUB_APP_ID: '123456',
    FORGE_GITHUB_APP_PRIVATE_KEY_FILE: '/run/credentials/forge-dispatch@forge:113.service/github-app-private-key',
  });

  assert.deepEqual(kept, { PATH: '/bin' });
});
