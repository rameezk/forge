import { execFile } from 'node:child_process';

const git = (
  dir: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  answersWithOne = false,
): Promise<{ stdout: string; one: boolean }> =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd: dir, env }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ stdout, one: false });
      } else if (answersWithOne && error.code === 1) {
        resolve({ stdout, one: true });
      } else {
        reject(new Error(`git ${args[0]} failed: ${stderr.trim() || error.message}`));
      }
    });
  });

export const fetchCommit = async (
  dir: string,
  env: NodeJS.ProcessEnv,
  sha: string,
): Promise<void> => {
  await git(dir, env, ['fetch', '--quiet', 'origin', sha]);
};

export const conflictedFiles = async (
  dir: string,
  env: NodeJS.ProcessEnv,
  sha: string,
): Promise<string[]> => {
  await fetchCommit(dir, env, sha);
  const merged = await git(dir, env, ['merge', '--no-commit', '--no-ff', '--quiet', sha], true);
  if (!merged.one) return [];
  const unmerged = await git(dir, env, ['diff', '--name-only', '--diff-filter=U']);
  const files = unmerged.stdout.split('\n').filter((file) => file !== '');
  if (files.length === 0) {
    throw new Error(`git merge of ${sha} failed without conflicting files`);
  }
  await git(dir, env, ['merge', '--abort']);
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
