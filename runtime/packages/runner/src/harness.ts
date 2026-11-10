import type { ContextIssue, FeedbackItem, HarnessOutput, TicketContext } from '@forge/shared';
import type { DevShell } from './devshell.ts';
import type { ListedModel } from './openrouter.ts';
import type { Provider } from './provider.ts';

export interface Checkout {
  root: string;
  skillPaths: string[];
  projectInstructions: string | null;
  systemPrompt: string | null;
  appendSystemPrompt: string | null;
  skills: ReadonlyMap<string, readonly string[]>;
  skillLines: ReadonlyMap<string, number>;
}

const SCOPED_CHECK_RULE = [
  'Run only the scoped local commands AGENTS.md lists for the areas you changed, never the full `make check-no-vm`.',
  'End your report with one line naming the local commands that passed, followed by "full suite: CI".',
  'When a required scoped command is killed or cannot run, stop and report that instead of running a narrower or different check.',
  "A missing dependency install is something to do as the repository's instructions say, not a required command that cannot run.",
];

const CI_RERUN_RULE = [
  'You may re-run a CI run, and only under these rules.',
  'Re-run only a failed run on the head of the pull request you work on.',
  'Re-run only when it failed for infrastructure reasons: no jobs created, a startup failure, a lost runner, or a cancellation you did not cause.',
  'Re-run the same run at most twice; if it still fails for infrastructure reasons, leave the pull request a draft and name the run, the failure and the attempts in your report.',
  'Never re-run a failing test or step, flaky or not: fix it.',
  'Never dispatch, disable, enable or delete anything in Actions.',
  'Never re-trigger CI with an empty commit or by closing and reopening the pull request.',
];

export const UNATTENDED_INSTRUCTION = [
  'You are running unattended: no human will answer questions or confirm anything while you work.',
  'Where a skill asks you to confirm something the ticket or its spec already settles, proceed without asking.',
  'Otherwise stop, and end with the question you need answered.',
  ...SCOPED_CHECK_RULE,
  ...CI_RERUN_RULE,
].join(' ');

const contextBlock = (heading: string, issue: ContextIssue): string =>
  [
    `${heading} #${issue.number}: ${issue.title}\n${issue.url}\n\n${issue.body}`,
    ...issue.comments.map(
      (comment, index) =>
        `Comment ${index + 1} by ${comment.author}: ${comment.url}\n${comment.body}`,
    ),
  ].join('\n\n');

export const dispatchContext = ({ ticket, spec }: TicketContext): string =>
  [
    `This is the context of the ticket${spec === null ? '' : ' and of its parent spec'}, with only the comments maintainers wrote. Work from it instead of reading the ticket's issue or its comments yourself.`,
    contextBlock('Ticket', ticket),
    ...(spec === null ? [] : [contextBlock('Parent spec', spec)]),
  ].join('\n\n');

export const REVISION_INSTRUCTION = [
  'A person reviews this pull request and will read your replies on it.',
  'Where a skill asks you to confirm something their feedback already settles, proceed without asking.',
  'Otherwise ask the question as a reply on the pull request and end your run at once, without waiting or polling for an answer.',
  'If you stop because you are blocked or have a question, post that as a reply on the pull request.',
  ...SCOPED_CHECK_RULE,
  ...CI_RERUN_RULE,
].join(' ');

export const revisionContext = (feedback: readonly FeedbackItem[]): string =>
  [
    'This revision exists because of the feedback below. Address exactly these items and answer each one on the pull request, linking its URL in your answer.',
    ...feedback.map(
      (item, index) =>
        `${index + 1}. ${item.kind} by ${item.author}${
          item.path === null ? '' : ` on ${item.path}${item.line === null ? '' : `:${item.line}`}`
        }: ${item.url}\n${item.body}`,
    ),
  ].join('\n\n');

export const CONFLICT_INSTRUCTION = [
  UNATTENDED_INSTRUCTION,
  "You are resolving the merge conflicts of a pull request against its default branch. Merge only the default branch sha the task names into the pull request's branch, and push the merge commit to that branch: never rebase, and never force-push.",
].join(' ');

export interface ConflictBrief {
  number: number;
  url: string;
  branch: string;
  defaultBranch: string;
  sha: string;
  files: readonly string[];
}

export const withContext = (prompt: string, context: string): string => `${prompt}\n\n${context}`;

export const conflictBrief = (brief: ConflictBrief): string =>
  [
    `Resolve the merge conflicts on pull request #${brief.number} (${brief.url}).`,
    `Merge the default branch ${brief.defaultBranch} at ${brief.sha} into the pull request's branch ${brief.branch}, resolve the conflicts, and push the merge commit to ${brief.branch}.`,
    `These files conflicted:\n${brief.files.map((file) => `- ${file}`).join('\n')}`,
  ].join('\n');

export const NARRATION_INSTRUCTION = [
  'Narrate your work: before your first tool call, and whenever you change direction or learn something that changes your plan, say in a sentence or two what you are about to do and why.',
  'Do not write a sentence before every tool call.',
].join(' ');

export interface Workspace {
  workDir: string;
  instruction?: string;
  baseCommit?: string;
  checkout?: Checkout;
  devShell?: DevShell;
}

export interface HarnessInvocation extends Workspace {
  model: string;
  prompt: string;
  reasoningEffort?: string;
}

export type RawEventSink = (event: unknown) => void;

export type RequestRecordSink = (line: unknown) => void;

export interface HarnessSinks {
  rawEvent: RawEventSink;
  requestRecord: RequestRecordSink;
  stop: AbortSignal;
}

export interface HarnessIdentity {
  version: string | null;
  args: string[];
}

export interface FingerprintBasis {
  settings: string | null;
  normalize(text: string): string;
}

export interface HarnessRunSetup {
  runId: string;
  model: string;
  listedModel: ListedModel | null;
}

export interface HarnessRun {
  identity(): Promise<HarnessIdentity>;
  fingerprintBasis(invocation: HarnessInvocation): FingerprintBasis;
  run(
    invocation: HarnessInvocation,
    sinks: HarnessSinks,
  ): AsyncIterable<HarnessOutput>;
}

export interface Harness {
  open(setup: HarnessRunSetup): HarnessRun;
}

export interface Worker {
  name: string;
  harness: string;
  provider: Provider;
  model: string;
  prompt: string;
  promptTemplate?: string;
  reasoningEffort?: string;
  timeoutSeconds?: number | null;
  maxCostUsd?: number | null;
}

export const withEffort = (
  effort: string | undefined,
): { reasoningEffort?: string } =>
  effort === undefined ? {} : { reasoningEffort: effort };

export const invocationFor = (
  worker: Worker,
  workspace: Workspace,
): HarnessInvocation => ({
  model: worker.model,
  prompt: worker.prompt,
  ...workspace,
  ...withEffort(worker.reasoningEffort),
});
