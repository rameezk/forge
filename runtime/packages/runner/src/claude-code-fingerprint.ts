import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { canonicalHash } from '@forge/shared';
import {
  contentHash,
  filesUnder,
  realpathOrSelf,
  replacingPaths,
} from './fingerprint.ts';

const SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'];

const HOOKS_DIR = '.claude/hooks';

export const claudeCodeSettingsHash = (workDir: string): string | null => {
  const files = [
    ...SETTINGS_FILES.map((file) => join(workDir, file)).filter(existsSync),
    ...(existsSync(join(workDir, HOOKS_DIR)) ? filesUnder(join(workDir, HOOKS_DIR)) : []),
  ];
  return files.length === 0
    ? null
    : canonicalHash(files.map((file) => [relative(workDir, file), contentHash(file)]));
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
