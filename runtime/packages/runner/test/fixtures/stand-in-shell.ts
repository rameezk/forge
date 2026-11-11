import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { accessSync, constants } from 'node:fs';
import { writeClaudeCodeConfig, type ClaudeCodeConfig, type ClaudeCodeShell } from '../../src/claude-code-config.ts';

const onPath = (name: string): string => {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(`${name} is not on PATH`);
};

export const standInShellCalls = (dir: string): string => join(dir, 'stand-in-shell', 'calls.log');

export const standInShell = (dir: string): ClaudeCodeShell => {
  const bash = onPath('bash');
  const shellDir = join(dir, 'stand-in-shell');
  mkdirSync(shellDir, { recursive: true });
  const calls = standInShellCalls(dir);
  const named = join(shellDir, 'bash');
  writeFileSync(named, `#!${bash}\necho shell >> ${calls}\nexec ${bash} "$@"\n`);
  chmodSync(named, 0o755);
  const prefix = join(shellDir, 'prefix');
  writeFileSync(prefix, `#!${bash}\necho prefix >> ${calls}\nexec ${bash} -c "$1"\n`);
  chmodSync(prefix, 0o755);
  return { bash: named, client: prefix };
};

export const prepareClaudeConfig = ({
  dir,
  workDir,
  configDir,
}: {
  dir: string;
  workDir: string;
  configDir: string;
}): ClaudeCodeConfig => {
  const owned = join(dir, 'owned');
  mkdirSync(owned, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const config = writeClaudeCodeConfig({ dir: owned, workDir, shell: standInShell(dir) });
  for (const [from, name] of [[config.settings, 'settings.json'], [config.instructions, 'CLAUDE.md']] as const) {
    rmSync(join(configDir, name), { force: true });
    copyFileSync(from, join(configDir, name));
  }
  return config;
};
