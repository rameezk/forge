import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const docsLogo = new URL('../../../../docs/assets/logo.svg', import.meta.url);
const frontendLogo = new URL('../assets/logo.svg', import.meta.url);

test('given the logo in the docs and its copy in the frontend, when the frontend tests run, then the two files are identical', () => {
  assert.ok(
    readFileSync(frontendLogo).equals(readFileSync(docsLogo)),
    'packages/frontend/assets/logo.svg must be a byte-for-byte copy of docs/assets/logo.svg',
  );
});
