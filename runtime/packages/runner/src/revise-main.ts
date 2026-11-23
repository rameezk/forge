import {
  errorMessage,
  queryFeedbackWindow,
  queryUnansweredFeedback,
  type Fetch,
} from '@forge/shared';
import { REVISION_INSTRUCTION, revisionContext } from './harness.ts';
import { runPullRequestWorkload, type PullRequestKind } from './pull-request-workload.ts';

const revision: PullRequestKind<'feedback'> = {
  command: 'forge-revise',
  trigger: 'feedback',
  refusal: 'cannot be revised',
  noun: 'revision',
  launch: { instruction: REVISION_INSTRUCTION, conflictResolution: false },
  prepare: async () => null,
  before: async ({ fetch, token, github, pullRequest }, _target, { after, startedAt }) => {
    const feedback = await queryFeedbackWindow(
      fetch,
      token,
      github,
      pullRequest.number,
      after,
      startedAt,
    );
    return feedback.length === 0 ? null : { context: revisionContext(feedback), carried: feedback };
  },
  after: async ({ fetch, app, github, pullRequest, identity }, _target, feedback) => {
    const unanswered = await queryUnansweredFeedback(
      fetch,
      (await app.mint(github, 'read')).token,
      github,
      pullRequest.number,
      identity.name,
      feedback,
    );
    return unanswered.length > 0
      ? { reason: 'unanswered', detail: unanswered.map(({ url }) => url).join('\n') }
      : undefined;
  },
};

export const main = (argv: string[], env: NodeJS.ProcessEnv, fetch: Fetch): Promise<number> =>
  runPullRequestWorkload(revision, argv, env, fetch);

if (import.meta.filename === process.argv[1]) {
  main(process.argv.slice(2), process.env, globalThis.fetch)
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(errorMessage(error));
      process.exit(1);
    });
}
