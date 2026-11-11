import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { claudeCodeInstructionsHash, claudeCodeNormalizer, claudeCodePluginHash, claudeCodeSettingsHash } from '../src/claude-code-fingerprint.ts';

const GIT_STATUS = (branch: string, status: string, commits: string): string =>
  `Intro.\n# gitStatus\nThis is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.\n\nCurrent branch: ${branch}\n\nMain branch (you will usually use this for PRs): main\n\nGit user: n\n\nStatus:\n${status}\n\nRecent commits:\n${commits}\n\nTrailing text that is part of the prompt.`;

test('given a system prompt carrying the date and a git status snapshot, when it is normalized, then the date and the snapshot become placeholders and the surrounding text is untouched', () => {
  const normalize = claudeCodeNormalizer({ workDir: '/nonexistent/work', configDir: '/nonexistent/config' });

  const first = normalize(
    `Today's date is 2026-10-13.\n${GIT_STATUS('main', '?? a.md\n M b.ts', 'abc one\ndef two')}`,
  );
  const second = normalize(
    `Today's date is 2027-01-02.\n${GIT_STATUS('feat/x', '(clean)', '123 three')}`,
  );

  assert.equal(first, second);
  assert.match(first, /^Today's date is <date>\./);
  assert.match(first, /conversation\.\n\n<git status>\n\nTrailing text that is part of the prompt\.$/);
});

test('given a system prompt naming the work dir, the config dir, the work dir\'s memory slug and a build suffix and a previous request id, when it is normalized, then each becomes its placeholder', () => {
  const normalize = claudeCodeNormalizer({ workDir: '/runs/7/work', configDir: '/runs/7/config' });

  assert.equal(
    normalize(
      'cc_version=2.1.296.a7e; cc_entrypoint=sdk-cli; cc_prev_req=req_011CVkqzXbq in /runs/7/work with memory at /runs/7/config/projects/-runs-7-work/memory/',
    ),
    'cc_version=2.1.296.<build>; cc_entrypoint=sdk-cli; cc_prev_req=<request> in <work dir> with memory at <config dir>/projects/<work dir slug>/memory/',
  );
});

const checkout = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'forge-claude-settings-'));
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
};

test('given forge\'s settings, when they are hashed, then the hash is a digest that does not depend on any checkout', () => {
  assert.match(claudeCodeSettingsHash(), /^[0-9a-f]{64}$/);
  assert.equal(claudeCodeSettingsHash(), claudeCodeSettingsHash());
});

const content = {
  '.claude/skills/first/SKILL.md': 'one\n',
  '.claude/agents/helper.md': 'one\n',
  '.claude/commands/hello.md': 'one\n',
};

test('given checkouts with and without skills, agents and commands, when their plugin directory is hashed, then none is null, each change to one of them changes the hash, and an identical checkout hashes alike', () => {
  const hash = claudeCodePluginHash(checkout(content));

  assert.match(claudeCodePluginHash(checkout({})) ?? '', /^[0-9a-f]{64}$/);
  assert.notEqual(claudeCodePluginHash(checkout({})), hash);
  assert.equal(claudeCodePluginHash(checkout(content)), hash);
  for (const file of Object.keys(content)) {
    assert.notEqual(claudeCodePluginHash(checkout({ ...content, [file]: 'two\n' })), hash, file);
  }
  assert.notEqual(claudeCodePluginHash(checkout({ ...content, '.claude/skills/second/SKILL.md': 'x' })), hash);
});

test('given a checkout with Claude Code settings and hook scripts, when its plugin directory is hashed, then they do not change the hash, because forge loads neither', () => {
  const hash = claudeCodePluginHash(checkout(content));

  assert.equal(
    claudeCodePluginHash(
      checkout({
        ...content,
        '.claude/settings.json': JSON.stringify({ hooks: { PreToolUse: [] }, env: { LD_PRELOAD: 'x' } }),
        '.claude/settings.local.json': '{}',
        '.claude/hooks/check.sh': 'echo one\n',
      }),
    ),
    hash,
  );
});

test('given a checkout whose skills, agents or commands directory is a symlink, when its plugin directory is hashed, then the target is not read, a loop terminates, and retargeting a link changes the hash', () => {
  const outside = checkout({ 'skills/first/SKILL.md': 'one\n' });
  const linked = checkout({});
  mkdirSync(join(linked, '.claude'));
  symlinkSync(join(outside, 'skills'), join(linked, '.claude/skills'));
  symlinkSync('.', join(linked, '.claude/agents'));
  const before = claudeCodePluginHash(linked);

  writeFileSync(join(outside, 'skills/first/SKILL.md'), 'two\n');
  assert.equal(claudeCodePluginHash(linked), before);

  rmSync(join(linked, '.claude/agents'));
  symlinkSync('..', join(linked, '.claude/agents'));
  assert.notEqual(claudeCodePluginHash(linked), before);
});

test('given a skill that is a symlink to a file inside the checkout, when that file changes, then the hash changes, but a link to a file outside the checkout is hashed by its target path alone', () => {
  const outside = checkout({ 'secret.md': 'one\n' });
  const root = checkout({ 'shared/SKILL.md': 'one\n' });
  mkdirSync(join(root, '.claude/skills/inside'), { recursive: true });
  mkdirSync(join(root, '.claude/skills/outside'), { recursive: true });
  symlinkSync('../../../shared/SKILL.md', join(root, '.claude/skills/inside/SKILL.md'));
  symlinkSync(join(outside, 'secret.md'), join(root, '.claude/skills/outside/SKILL.md'));
  const before = claudeCodePluginHash(root);

  writeFileSync(join(outside, 'secret.md'), 'two\n');
  assert.equal(claudeCodePluginHash(root), before);

  writeFileSync(join(root, 'shared/SKILL.md'), 'two\n');
  assert.notEqual(claudeCodePluginHash(root), before);
});

test('given checkouts with and without AGENTS.md and CLAUDE.md, when their instructions are hashed, then none is null, both files are covered because forge imports both, and each change to either changes the hash', () => {
  const both = { 'AGENTS.md': 'one\n', 'CLAUDE.md': 'two\n' };
  const hash = claudeCodeInstructionsHash(checkout(both));

  assert.equal(claudeCodeInstructionsHash(checkout({})), null);
  assert.equal(claudeCodeInstructionsHash(checkout({ 'README.md': 'x' })), null);
  assert.equal(claudeCodeInstructionsHash(checkout(both)), hash);
  assert.notEqual(claudeCodeInstructionsHash(checkout({ ...both, 'AGENTS.md': 'three\n' })), hash);
  assert.notEqual(claudeCodeInstructionsHash(checkout({ ...both, 'CLAUDE.md': 'three\n' })), hash);
  assert.notEqual(claudeCodeInstructionsHash(checkout({ 'AGENTS.md': 'one\n' })), hash);
  assert.notEqual(claudeCodeInstructionsHash(checkout({ 'CLAUDE.md': 'two\n' })), hash);
  assert.notEqual(claudeCodeInstructionsHash(checkout({ 'AGENTS.md': 'one\n' })), null);
});

test('given a checkout whose AGENTS.md is a symlink to a file outside it, when its instructions are hashed, then the outside file is not read', () => {
  const outside = checkout({ 'secret.md': 'one\n' });
  const first = checkout({});
  symlinkSync(join(outside, 'secret.md'), join(first, 'AGENTS.md'));
  writeFileSync(join(outside, 'secret.md'), 'two\n');

  const before = claudeCodeInstructionsHash(first);
  writeFileSync(join(outside, 'secret.md'), 'three\n');

  assert.match(before ?? '', /^[0-9a-f]{64}$/);
  assert.equal(claudeCodeInstructionsHash(first), before);
});
