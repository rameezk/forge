import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGithubRepository } from '../src/index.ts';

test('given an owner/name, when checked, then it is a GitHub repository', () => {
  assert.equal(isGithubRepository('rameezk/forge'), true);
  assert.equal(isGithubRepository('rameezk/forge.site_2'), true);
});

test('given a name that would climb out of the repository path, when checked, then it is not a GitHub repository', () => {
  assert.equal(isGithubRepository('rameezk/..'), false);
  assert.equal(isGithubRepository('rameezk/.'), false);
  assert.equal(isGithubRepository('../forge'), false);
});
