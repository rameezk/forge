import { lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { canonicalHash } from '@forge/shared';
import { claudeCodeSettings, INSTRUCTION_FILES, PLUGIN_CONTENT } from './claude-code-config.ts';
import {
  contentHash,
  realpathOrSelf,
  replacingPaths,
} from './fingerprint.ts';

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

const contentEntries = (dir: string): string[] => {
  const kind = kindOf(dir);
  if (kind === 'symlink') return [dir];
  return kind === 'directory' ? entriesUnder(dir) : [];
};

const hashedEntries = (workDir: string, paths: string[]): string[][] =>
  paths.flatMap((path) => {
    const hash = entryHash(workDir, path);
    return hash === null ? [] : [[relative(workDir, path), hash]];
  });

const PLACEHOLDER_SHELL = { bash: '<shell>', client: '<shell prefix>' };

export const claudeCodeSettingsHash = (): string =>
  canonicalHash(JSON.stringify(claudeCodeSettings(PLACEHOLDER_SHELL)));

export const claudeCodePluginHash = (workDir: string): string => {
  const claudeDir = join(workDir, '.claude');
  const paths =
    kindOf(claudeDir) === 'symlink'
      ? [claudeDir]
      : PLUGIN_CONTENT.flatMap((name) => contentEntries(join(claudeDir, name)));
  return canonicalHash(hashedEntries(workDir, paths));
};

export const claudeCodeInstructionsHash = (workDir: string): string | null => {
  const entries = hashedEntries(
    workDir,
    INSTRUCTION_FILES.map((file) => join(workDir, file)),
  );
  return entries.length === 0 ? null : canonicalHash(entries);
};

const slugOf = (path: string): string => path.replace(/[^a-zA-Z0-9]/g, '-');

const BUILD_SUFFIX = /(cc_version=\d+\.\d+\.\d+)\.[0-9a-f]+/g;

const PREVIOUS_REQUEST = /(cc_prev_req=)[^;\s]+/g;

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
        .replace(PREVIOUS_REQUEST, '$1<request>')
        .replace(TODAY, '$1<date>')
        .replace(GIT_STATUS, '$1\n\n<git status>'),
    );
};
