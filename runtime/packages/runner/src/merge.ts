import { execFile } from 'node:child_process';

interface GitResult {
  code: number;
  stdout: string;
}

const git = (dir: string, env: NodeJS.ProcessEnv, args: string[]): Promise<GitResult> =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd: dir, env }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ code: 0, stdout });
      } else if (typeof error.code === 'number' && error.code === 1) {
        resolve({ code: 1, stdout });
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
  const merged = await git(dir, env, ['merge', '--no-commit', '--no-ff', '--quiet', sha]);
  if (merged.code === 0) return [];
  const unmerged = await git(dir, env, ['diff', '--name-only', '--diff-filter=U']);
  await git(dir, env, ['merge', '--abort']);
  return unmerged.stdout.split('\n').filter((file) => file !== '');
};

export const containsCommit = async (
  dir: string,
  env: NodeJS.ProcessEnv,
  head: string,
  sha: string,
): Promise<boolean> => {
  await fetchCommit(dir, env, head);
  await fetchCommit(dir, env, sha);
  return (await git(dir, env, ['merge-base', '--is-ancestor', sha, head])).code === 0;
};
