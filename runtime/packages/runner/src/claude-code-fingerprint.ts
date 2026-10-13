import { lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { canonicalHash } from '@forge/shared';
import {
  contentHash,
  realpathOrSelf,
  replacingPaths,
} from './fingerprint.ts';

const SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'];

const HOOKS_DIR = '.claude/hooks';

const insideCheckout = (workDir: string, path: string): boolean => {
  try {
    const root = realpathSync(workDir);
    const resolved = realpathSync(path);
    return resolved.startsWith(`${root}${sep}`) && lstatSync(resolved).isFile();
  } catch {
    return false;
  }
};

const entryHash = (workDir: string, path: string): string | null => {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = `symlink:${readlinkSync(path)}`;
      return insideCheckout(workDir, path) ? `${target}:${contentHash(realpathSync(path))}` : target;
    }
    return stat.isFile() ? contentHash(path) : null;
  } catch {
    return null;
  }
};

const kindOf = (path: string): 'directory' | 'symlink' | 'other' | 'missing' => {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return 'symlink';
    return stat.isDirectory() ? 'directory' : 'other';
  } catch {
    return 'missing';
  }
};

const childrenOf = (dir: string): string[] => {
  try {
    return readdirSync(dir).sort().map((name) => join(dir, name));
  } catch {
    return [];
  }
};

const entriesUnder = (path: string): string[] =>
  kindOf(path) === 'directory' ? childrenOf(path).flatMap(entriesUnder) : [path];

const hookEntries = (dir: string): string[] => {
  const kind = kindOf(dir);
  if (kind === 'symlink') return [dir];
  return kind === 'directory' ? entriesUnder(dir) : [];
};

export const claudeCodeSettingsHash = (workDir: string): string | null => {
  const claudeDir = join(workDir, '.claude');
  const paths =
    kindOf(claudeDir) === 'symlink'
      ? [claudeDir]
      : [...SETTINGS_FILES.map((file) => join(workDir, file)), ...hookEntries(join(workDir, HOOKS_DIR))];
  const entries = paths.flatMap((path) => {
    const hash = entryHash(workDir, path);
    return hash === null ? [] : [[relative(workDir, path), hash]];
  });
  return entries.length === 0 ? null : canonicalHash(entries);
};

const slugOf = (path: string): string => path.replace(/[^a-zA-Z0-9]/g, '-');

const BUILD_SUFFIX = /(cc_version=\d+\.\d+\.\d+)\.[0-9a-f]+/g;

const TODAY = /(Today's date is )\d{4}-\d{2}-\d{2}/g;

const GIT_STATUS_INTRO =
  'This is the git status at the start of the conversation\\. Note that this status is a snapshot in time, and will not update during the conversation\\.';

const GIT_STATUS_SECTION =
  '\\n\\n(?:Current branch:|Main branch \\(|Git user:|Status:|Recent commits:)[^\\n]*(?:\\n[^\\n]+)*';

const GIT_STATUS = new RegExp(`(${GIT_STATUS_INTRO})(?:${GIT_STATUS_SECTION})+`, 'g');

export const claudeCodeNormalizer = ({
  workDir,
  configDir,
}: {
  workDir: string;
  configDir: string;
}): ((text: string) => string) => {
  const paths = replacingPaths([
    [workDir, '<work dir>'],
    [configDir, '<config dir>'],
  ]);
  const slugs = [...new Set([slugOf(realpathOrSelf(workDir)), slugOf(workDir)])];
  return (text) =>
    paths(
      slugs
        .reduce((replaced, slug) => replaced.replaceAll(slug, '<work dir slug>'), text)
        .replace(BUILD_SUFFIX, '$1.<build>')
        .replace(TODAY, '$1<date>')
        .replace(GIT_STATUS, '$1\n\n<git status>'),
    );
};
