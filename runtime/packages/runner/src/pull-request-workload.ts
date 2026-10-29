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

export interface WorkloadEnd {
  state: Exclude<RevisionState, 'running'>;
  failure?: { reason: 'interrupted' | 'exceeded'; detail: string | null };
}

export const endOf = ({ run }: LaunchResult): WorkloadEnd => {
  if (run.status === 'success') return { state: 'done' };
  if (run.status === 'exceeded') {
    return { state: 'failed', failure: { reason: 'exceeded', detail: run.exceededLimit } };
  }
  if (run.status === 'interrupted') {
    return { state: 'failed', failure: { reason: 'interrupted', detail: null } };
  }
  return { state: 'failed' };
};
