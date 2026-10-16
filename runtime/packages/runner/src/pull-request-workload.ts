import type { PullRequestHead, RevisionState } from '@forge/shared';
import type { LaunchResult } from './workload.ts';

export const fillPrompt = (
  template: string,
  github: string,
  pullRequest: PullRequestHead,
): string =>
  template
    .replaceAll('{repo}', github)
    .replaceAll('{pr}', String(pullRequest.number))
    .replaceAll('{url}', pullRequest.url)
    .replaceAll('{branch}', pullRequest.branch);

export const headRefusal = (pullRequest: PullRequestHead): string | null => {
  if (!pullRequest.open) return 'it is not open';
  if (pullRequest.fromFork) return 'its branch is on a fork';
  return null;
};

export const stateOf = ({ run }: LaunchResult): Exclude<RevisionState, 'running'> =>
  run.status === 'success' ? 'ok' : run.status === 'running' ? 'error' : run.status;
