import { finish } from './setup.ts';

const git = async (
  dir: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  answersWithOne = false,
  signal?: AbortSignal,
): Promise<{ stdout: string; one: boolean }> => {
  const { code, stdout, stderr } = await finish('git', args, {
    cwd: dir,
    env,
    ...(signal === undefined ? {} : { signal }),
  });
  if (code === 0) return { stdout, one: false };
  if (answersWithOne && code === 1) return { stdout, one: true };
  throw new Error(`git ${args[0]} failed: ${stderr.trim() || `exited with ${code}`}`);
};

export const fetchCommit = async (
  dir: string,
  env: NodeJS.ProcessEnv,
  sha: string,
  signal?: AbortSignal,
): Promise<void> => {
  await git(dir, env, ['fetch', '--quiet', 'origin', sha], false, signal);
};

export const conflictedFiles = async (
  dir: string,
  env: NodeJS.ProcessEnv,
  sha: string,
  signal?: AbortSignal,
): Promise<string[]> => {
  await fetchCommit(dir, env, sha, signal);
  const merged = await git(dir, env, ['merge', '--no-commit', '--no-ff', '--quiet', sha], true, signal);
  if (!merged.one) return [];
  const unmerged = await git(dir, env, ['diff', '--name-only', '--diff-filter=U'], false, signal);
  const files = unmerged.stdout.split('\n').filter((file) => file !== '');
  if (files.length === 0) {
    throw new Error(`git merge of ${sha} failed without conflicting files`);
  }
  await git(dir, env, ['merge', '--abort'], false, signal);
  return files;
};

export const containsCommit = async (
  dir: string,
  env: NodeJS.ProcessEnv,
  head: string,
  sha: string,
): Promise<boolean> => {
  await fetchCommit(dir, env, head);
  await fetchCommit(dir, env, sha);
  const notAncestor = await git(dir, env, ['merge-base', '--is-ancestor', sha, head], true);
  return !notAncestor.one;
};
