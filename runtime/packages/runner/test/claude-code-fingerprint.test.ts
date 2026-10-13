import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { claudeCodeNormalizer, claudeCodeSettingsHash } from '../src/claude-code-fingerprint.ts';

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

test('given a system prompt naming the work dir, the config dir, the work dir\'s memory slug and a build suffix, when it is normalized, then each becomes its placeholder', () => {
  const normalize = claudeCodeNormalizer({ workDir: '/runs/7/work', configDir: '/runs/7/config' });

  assert.equal(
    normalize(
      'cc_version=2.1.296.a7e in /runs/7/work with memory at /runs/7/config/projects/-runs-7-work/memory/',
    ),
    'cc_version=2.1.296.<build> in <work dir> with memory at <config dir>/projects/<work dir slug>/memory/',
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

test('given checkouts with Claude Code settings and hook scripts, when their settings are hashed, then none is null, each change to settings or a hook script changes the hash, and an identical checkout hashes alike', () => {
  const settings = JSON.stringify({ hooks: { PreToolUse: [] } });
  const base = { '.claude/settings.json': settings, '.claude/hooks/check.sh': 'echo one\n' };

  const hash = claudeCodeSettingsHash(checkout(base));

  assert.equal(claudeCodeSettingsHash(checkout({})), null);
  assert.equal(claudeCodeSettingsHash(checkout({ 'README.md': 'x' })), null);
  assert.equal(claudeCodeSettingsHash(checkout(base)), hash);
  assert.notEqual(claudeCodeSettingsHash(checkout({ ...base, '.claude/hooks/check.sh': 'echo two\n' })), hash);
  assert.notEqual(claudeCodeSettingsHash(checkout({ ...base, '.claude/settings.json': '{}' })), hash);
  assert.notEqual(claudeCodeSettingsHash(checkout({ ...base, '.claude/settings.local.json': '{}' })), hash);
});
