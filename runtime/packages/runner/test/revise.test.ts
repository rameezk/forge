import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { Store } from '@forge/shared';
import { UNATTENDED_INSTRUCTION } from '../src/harness.ts';
import { BOT_EMAIL, BOT_LOGIN } from '../../shared/test/fixtures/fake-github-app.ts';
import { git, DEFAULT_RESOURCE_NOTE, assertRepositoryNeutralCheckRule } from './helpers.ts';
import { PULL_REQUEST_URL, SKILL, originWith, OWNER, feedbackWindow, conversationComment, FORGE_APP, reactedWith, thumbsUp, noReactions, feedbackAnswers, repliedBy, instructionOf, userMessageOf, revise } from './revise-driver.ts';

test('given a repository with on.feedback and an open pull request on branch feature, when forge-revise runs, then the feedback worker starts in a fresh clone of feature with the placeholders filled, and a commit it pushes lands on feature', async () => {
  const { code, origin, pi, gitConfig } = await revise();

  assert.equal(code, 0);
  assert.ok(pi);
  assert.ok(
    userMessageOf(pi).startsWith(
      `/skill:address-feedback ${PULL_REQUEST_URL} on feature of rameezk/forge (#143)\n\n`,
    ),
  );
  const workDir = realpathSync(pi.cwd);
  assert.equal(git(workDir, 'branch', '--show-current'), 'feature');
  assert.equal(git(workDir, 'rev-parse', 'HEAD'), origin.featureTip);
  assert.equal(git(workDir, 'config', 'remote.origin.partialclonefilter'), 'blob:none');
  execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'address feedback'], {
    cwd: workDir,
    env: { ...pi.env, ...gitConfig },
  });
  execFileSync('git', ['push', '--quiet', 'origin', 'HEAD'], {
    cwd: workDir,
    env: { ...pi.env, ...gitConfig },
  });
  assert.equal(git(origin.path, 'log', '-1', '--format=%s', 'feature'), 'address feedback');
  assert.equal(
    git(origin.path, 'log', '-1', '--format=%an <%ae>%n%cn <%ce>', 'feature'),
    `${BOT_LOGIN} <${BOT_EMAIL}>\n${BOT_LOGIN} <${BOT_EMAIL}>`,
  );
});

test('given a feedback worker whose prompt starts with /address-feedback, when the pull request\'s branch has no such skill, then the revision fails before pi starts, and when it has the skill, pi runs it', async () => {
  const missing = await revise({
    origin: originWith({ '.claude/skills/other/SKILL.md': SKILL.replace('address-feedback', 'other') }),
  });
  const present = await revise();

  assert.equal(missing.code, 1);
  assert.equal(missing.pi, null);
  assert.equal(missing.runs[0]?.status, 'error');
  assert.equal(missing.runs[0]?.error, "skill 'address-feedback' not found in the checkout");
  assert.deepEqual(missing.revisions.map(({ state }) => state), ['failed']);
  assert.match(present.pi?.argv.at(-1) ?? '', /^\/skill:address-feedback /);
});

test('given any revision, when pi starts, then its fixed instruction tells it to ask on the pull request and end its run without waiting, and does not say that no human will answer', async () => {
  const { pi } = await revise();

  assert.ok(pi);
  const instructions = pi.argv.filter((_, index) => pi.argv[index - 1] === '--append-system-prompt');
  const revision = instructions.find((text) => text.includes('reply on the pull request'));
  assert.match(revision ?? '', /end your run at once, without waiting or polling for an answer/);
  assert.equal(instructions.some((text) => text.includes('no human will answer')), false);
  assert.equal(instructions.includes(UNATTENDED_INSTRUCTION), false);
  assertRepositoryNeutralCheckRule(revision ?? '');
});

test('given a revision with feedback to address, when it runs, then its instruction says to post a block or question as a reply on the pull request', async () => {
  const { pi } = await revise();

  assert.match(
    instructionOf(pi),
    /stop because you are blocked or have a question, post that as a reply on the pull request/,
  );
});

test('given a revision handed one item, when the worker replies on the pull request linking the item to say it is blocked and does not push, then the revision ends ok and the cursor stays at its start', async () => {
  const { code, revisions, nextAfter } = await revise({
    answers: feedbackAnswers({
      comments: [
        { ...conversationComment(), ...noReactions },
        {
          url: `${PULL_REQUEST_URL}#issuecomment-2`,
          body: `Blocked on ${COMMENT_URL}: cannot proceed without a decision`,
          author: FORGE_APP,
          createdAt: '2026-09-22T11:00:00Z',
          ...noReactions,
        },
      ],
    }),
  });

  assert.equal(code, 0);
  assert.deepEqual(revisions.map(({ state, reason }) => ({ state, reason })), [
    { state: 'done', reason: null },
  ]);
  assert.equal(nextAfter, revisions[0]?.startedAt);
});

test('given a revision that ends ok, when it is recorded, then it is against its pull request and run and linked to the dispatch that opened the pull request', async () => {
  const { code, runs, revisions } = await revise({
    seed: (store) => {
      const start = store.startDispatch(
        { repository: 'forge', number: 113, url: 'https://github.com/rameezk/forge/issues/113' },
        'opening-run',
        '2026-09-21T10:00:00.000Z',
        10,
        null,
      );
      assert.ok('started' in start);
      store.endDispatch(
        start.started,
        { state: 'done', pullRequest: { number: 143, url: PULL_REQUEST_URL } },
        '2026-09-21T10:30:00.000Z',
      );
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(
    revisions.map(({ repository, number, url, runId, dispatchId, state }) => ({
      repository, number, url, runId, dispatchId, state,
    })),
    [{ repository: 'forge', number: 143, url: PULL_REQUEST_URL, runId: runs[0]?.id, dispatchId: 1, state: 'done' }],
  );
});

const previousRevisionAt = (startedAt: string) => (store: Store) => {
  const start = store.startRevision(
    { repository: 'forge', number: 143, url: PULL_REQUEST_URL },
    [],
    'previous-run',
    startedAt,
    10,
  );
  assert.ok('started' in start);
  store.endRevision(start.started, 'done', startedAt);
};

test('given a window holding a review summary, an inline review comment and a conversation comment by the owner, when the revision runs, then the instruction lists all three with their kind, author, URL and body, and the inline comment with its file and line', async () => {
  const { pi } = await revise({
    feedback: feedbackWindow({
      reviews: [
        {
          url: `${PULL_REQUEST_URL}#pullrequestreview-7`,
          author: OWNER,
          body: 'Overall this needs a second look.',
          submittedAt: '2026-09-22T09:00:00Z',
          comments: {
            nodes: [
              {
                url: `${PULL_REQUEST_URL}#discussion_r9`,
                author: OWNER,
                body: 'This loop is off by one.',
                createdAt: '2026-09-22T09:00:00Z',
                path: 'src/loop.ts',
                line: 42,
              },
            ],
          },
        },
      ],
      comments: [conversationComment()],
    }),
  });

  const instruction = userMessageOf(pi);
  assert.match(instruction, /review summary by rameezk: .*#pullrequestreview-7/);
  assert.match(instruction, /Overall this needs a second look\./);
  assert.match(instruction, /inline review comment by rameezk on src\/loop\.ts:42: .*#discussion_r9/);
  assert.match(instruction, /This loop is off by one\./);
  assert.match(instruction, /conversation comment by rameezk: .*#issuecomment-1/);
  assert.match(instruction, /Please rename the helper\./);
  assert.match(instruction, /Address exactly these items and answer each one/);
  assert.doesNotMatch(instructionOf(pi), /Overall this needs a second look|This loop is off by one|Please rename the helper|Address exactly these items/);
});

test('given a comment from before the previous revision started and one from after, when the next revision runs, then only the later comment is in the instruction', async () => {
  const { pi } = await revise({
    seed: previousRevisionAt('2026-09-21T10:00:00.000Z'),
    feedback: feedbackWindow({
      comments: [
        conversationComment({ body: 'Already handled earlier.', createdAt: '2026-09-21T09:59:00Z' }),
        conversationComment({ body: 'Newly raised.', createdAt: '2026-09-21T10:01:00Z' }),
      ],
    }),
  });

  const instruction = userMessageOf(pi);
  assert.match(instruction, /Newly raised\./);
  assert.doesNotMatch(instruction, /Already handled earlier\./);
});

test('given a revision that ended in error over a comment, when forge-revise runs again with no new feedback, then the comment is handed over again and pi starts', async () => {
  const { pi, code } = await revise({
    seed: (store) => {
      previousRevisionAt('2026-09-21T10:00:00.000Z')(store);
      const failed = store.startRevision(
        { repository: 'forge', number: 143, url: PULL_REQUEST_URL },
        [],
        'failed-run',
        '2026-09-21T10:10:00.000Z',
        10,
      );
      assert.ok('started' in failed);
      store.endRevision(failed.started, 'failed', '2026-09-21T10:11:00.000Z');
    },
    feedback: feedbackWindow({
      comments: [conversationComment({ body: 'Raised before the failure.', createdAt: '2026-09-21T10:05:00Z' })],
    }),
  });

  assert.equal(code, 0);
  assert.match(userMessageOf(pi), /Raised before the failure\./);
});

test('given a window holding comments from a maintainer, a read-only collaborator, an outsider and a bot, when the revision runs, then only the maintainer\'s comment is in the instruction', async () => {
  const { pi } = await revise({
    permissions: { helper: 'write', reader: 'read', 'dependabot': 'write' },
    feedback: feedbackWindow({
      comments: [
        conversationComment({
          author: { __typename: 'User', login: 'helper' },
          body: 'From a maintainer.',
        }),
        conversationComment({
          author: { __typename: 'User', login: 'reader' },
          body: 'From a reader.',
        }),
        conversationComment({
          author: { __typename: 'User', login: 'stranger' },
          body: 'From a stranger.',
        }),
        conversationComment({
          author: { __typename: 'Bot', login: 'dependabot' },
          body: 'From a bot.',
        }),
      ],
    }),
  });

  const instruction = userMessageOf(pi);
  assert.match(instruction, /From a maintainer\./);
  assert.doesNotMatch(instruction, /From a reader\./);
  assert.doesNotMatch(instruction, /From a stranger\./);
  assert.doesNotMatch(instruction, /From a bot\./);
});

test('given a revision whose window holds no feedback, when it runs, then pi never starts and the revision ends ok', async () => {
  const { code, pi, runs, revisions } = await revise({ feedback: feedbackWindow() });

  assert.equal(code, 0);
  assert.equal(pi, null);
  assert.deepEqual(runs, []);
  assert.deepEqual(revisions.map(({ state }) => state), ['done']);
});

const inlineReview = (comments: { url: string; createdAt: string }[]) => ({
  url: `${PULL_REQUEST_URL}#pullrequestreview-7`,
  author: OWNER,
  body: 'Overall this needs a second look.',
  submittedAt: '2026-09-22T09:00:00Z',
  comments: {
    nodes: comments.map(({ url, createdAt }) => ({
      url,
      author: OWNER,
      body: 'This loop is off by one.',
      createdAt,
      path: 'src/loop.ts',
      line: 42,
    })),
  },
});

const INLINE_URL = `${PULL_REQUEST_URL}#discussion_r9`;
const REVIEW_URL = `${PULL_REQUEST_URL}#pullrequestreview-7`;
const COMMENT_URL = `${PULL_REQUEST_URL}#issuecomment-1`;

test('given a revision handed an inline comment, a review summary and a conversation comment, when after the run the thread has a reply, a conversation comment contains the summary\'s URL and forge\'s App has reacted 👍 to the conversation comment, then the revision ends ok', async () => {
  const { code, revisions } = await revise({
    feedback: feedbackWindow({
      reviews: [inlineReview([{ url: INLINE_URL, createdAt: '2026-09-22T09:00:00Z' }])],
      comments: [conversationComment()],
    }),
    answers: feedbackAnswers({
      threads: [
        {
          comments: {
            nodes: [
              { url: INLINE_URL, author: OWNER, createdAt: '2026-09-22T09:00:00Z', ...noReactions },
              repliedBy(FORGE_APP),
            ],
          },
        },
      ],
      comments: [
        { ...conversationComment(), ...thumbsUp() },
        {
          url: `${PULL_REQUEST_URL}#issuecomment-2`,
          body: `Addressed ${REVIEW_URL}`,
          author: FORGE_APP,
          createdAt: '2026-09-22T11:00:00Z',
          ...noReactions,
        },
      ],
    }),
  });

  assert.equal(code, 0);
  assert.deepEqual(revisions.map(({ state, reason }) => ({ state, reason })), [
    { state: 'done', reason: null },
  ]);
});

test('given GitHub answers the answered check with a complete answer and errors, when forge-revise runs and the worker succeeds, then the revision fails as rejected rather than using the data', async () => {
  const { code, thrown, revisions } = await revise({
    answers: {
      ...feedbackAnswers({ comments: [{ ...conversationComment(), ...thumbsUp() }] }),
      errors: [{ message: 'Something went wrong' }, { message: 'Again' }],
    },
  });

  const message =
    'GitHub rejected the FeedbackAnswers query for rameezk/forge#143: Something went wrong; Again';
  assert.equal(code, 1);
  assert.equal(thrown, message);
  assert.deepEqual(revisions.map(({ state, reason, detail }) => ({ state, reason, detail })), [
    { state: 'failed', reason: 'crashed', detail: message },
  ]);
});

test('given GitHub answers the answered check with a null pull request and no errors, when forge-revise runs and the worker succeeds, then the error says GitHub found no pull request', async () => {
  const { code, thrown } = await revise({
    answers: { data: { repository: { pullRequest: null } }, errors: [] },
  });

  assert.equal(code, 1);
  assert.equal(thrown, 'GitHub found no pull request rameezk/forge#143');
});

test('given a revision handed two items, when after the run only one has been answered, then the revision fails as unanswered, its detail names the other item\'s URL', async () => {
  const { code, revisions } = await revise({
    feedback: feedbackWindow({
      comments: [
        conversationComment(),
        conversationComment({ url: `${PULL_REQUEST_URL}#issuecomment-2`, body: 'And the name.' }),
      ],
    }),
    answers: feedbackAnswers({
      comments: [
        { ...conversationComment(), ...thumbsUp() },
        { ...conversationComment({ url: `${PULL_REQUEST_URL}#issuecomment-2` }), ...noReactions },
      ],
    }),
  });

  assert.equal(code, 1);
  assert.deepEqual(revisions.map(({ state, reason, detail }) => ({ state, reason, detail })), [
    { state: 'failed', reason: 'unanswered', detail: `${PULL_REQUEST_URL}#issuecomment-2` },
  ]);
});

test('given a revision handed a conversation comment that forge\'s App reacted to with a 👍, when forge-revise checks answers with a token for a different identity, then the comment is unanswered', async () => {
  const { code, revisions } = await revise({ viewerKind: 'write' });

  assert.equal(code, 1);
  assert.deepEqual(revisions.map(({ state, reason, detail }) => ({ state, reason, detail })), [
    { state: 'failed', reason: 'unanswered', detail: COMMENT_URL },
  ]);
});

test('given a revision handed a conversation comment, when the only response is a 👍 from someone other than forge\'s App, then the revision fails as unanswered', async () => {
  const { code, revisions } = await revise({
    answers: feedbackAnswers({
      comments: [
        {
          ...conversationComment(),
          ...thumbsUp({ __typename: 'User', login: 'helper' }),
        },
      ],
    }),
  });

  assert.equal(code, 1);
  assert.deepEqual(revisions.map(({ state, reason, detail }) => ({ state, reason, detail })), [
    { state: 'failed', reason: 'unanswered', detail: COMMENT_URL },
  ]);
});

test('given a revision handed a conversation comment, when forge\'s App reacted with something other than a 👍, then the revision fails as unanswered', async () => {
  const { code, revisions } = await revise({
    answers: feedbackAnswers({
      comments: [{ ...conversationComment(), ...reactedWith('HEART') }],
    }),
  });

  assert.equal(code, 1);
  assert.deepEqual(revisions.map(({ state, reason, detail }) => ({ state, reason, detail })), [
    { state: 'failed', reason: 'unanswered', detail: COMMENT_URL },
  ]);
});

test('given forge\'s App commented with a URL that only starts with an unanswered item\'s URL, when the revision ends, then the item is still unanswered', async () => {
  const { code, revisions } = await revise({
    answers: feedbackAnswers({
      comments: [
        { ...conversationComment(), ...noReactions },
        {
          url: `${PULL_REQUEST_URL}#issuecomment-2`,
          body: `Addressed ${COMMENT_URL}0`,
          author: FORGE_APP,
          createdAt: '2026-09-22T11:00:00Z',
          ...noReactions,
        },
      ],
    }),
  });

  assert.equal(code, 1);
  assert.deepEqual(revisions.map(({ reason, detail }) => ({ reason, detail })), [
    { reason: 'unanswered', detail: COMMENT_URL },
  ]);
});

test('given a pull request with feedback, when forge-revise runs, then the prompt ends with the resource note, which states the shared memory limit and CPU count and never says budget', async () => {
  const { pi } = await revise();

  const prompt = userMessageOf(pi);
  assert.ok(prompt.endsWith(`\n\n${DEFAULT_RESOURCE_NOTE}`));
  assert.doesNotMatch(DEFAULT_RESOURCE_NOTE, /budget/i);
});
