---
name: git-pr-address-comments
description: Address the unresolved review comments on a GitHub PR end-to-end - fetch every open thread, fix what each asks through a test-first loop, then reply. Use when the user asks to "address the PR comments" / "handle review feedback" on a pull request.
disable-model-invocation: true
---

# Git PR Address Comments

Take a PR that already exists and work its unresolved review comments to done:
fetch every open thread, fix what each one asks for test-first, commit the fixes,
then reply. This operates on an open PR - it does not raise one (that was
[[git-pr]]) and it does not merge one.

Replying is where this skill stops - it does not resolve threads. Resolving a
thread is the reviewer's call, made once they are satisfied with the reply; the
skill leaves every thread open with an answer on it.

The signal for what to act on is **thread state, not authorship**: address every
*unresolved* thread, whoever wrote it. A review bot (CodeRabbit, Copilot, Claude
Code's `/code-review --comment`) is treated exactly like any other comment - the
author never changes whether or how a thread gets addressed.

## When to use

- The user asks to "address the PR comments", "handle the review feedback", or
  "action the comments" on a pull request.
- A PR has review threads left open that need working through.

## Identify the target PR

Work on the PR the user names - a number or URL. If they name none, resolve it
from the current branch:

```bash
gh pr view --json number,headRefName,url
```

Resolve the repository's `owner` and `name` too - the GraphQL and REST calls
below need them:

```bash
gh repo view --json owner,name -q '.owner.login + " " + .name'
```

Assumes `gh` is authenticated. If `gh auth status` fails, stop and ask the user
to run `gh auth login`.

Check out the PR's branch so fixes land on the right ref, if not already on it:

```bash
gh pr checkout <number>
```

No worktree ceremony - the branch already exists; just be on it.

## Fetch the unresolved threads

Use `gh api graphql`. The REST API cannot report whether a thread is resolved,
so the GraphQL `reviewThreads` connection is the source of truth for which
threads are still open. Fetch thread state and each comment's location and body.

A heavily-reviewed PR can have more than one page of threads, and dropping the
overflow would silently leave real feedback unaddressed. Drain every page with
`--paginate`, which follows the `pageInfo` cursor and concatenates the results:

```bash
gh api graphql --paginate -f query='
query($owner:String!, $repo:String!, $number:Int!, $endCursor:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      reviewThreads(first:100, after:$endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          comments(first:100) {
            nodes {
              databaseId
              path
              line
              startLine
              originalLine
              diffHunk
              body
              author { login }
            }
          }
        }
      }
    }
  }
}' -f owner=<owner> -f repo=<repo> -F number=<number>
```

Keep only threads where `isResolved` is `false`. If none are open, say so and
stop - there is nothing to address. A thread whose comments themselves exceed
100 is rare; if you hit one, page its `comments` connection the same way.

`line` is `null` for a comment on code that has since changed (an outdated
thread); fall back to `originalLine`/`startLine` and the `diffHunk` to locate
what it refers to.

Top-level PR conversation comments (issue comments, not tied to a diff line) are
separate: fetch them with `gh pr view <number> --json comments` if the user's
feedback lives there too. They are replied to the same way.

## Triage each thread

Classify every unresolved thread:

- **(a) an actionable code change** - the comment asks for something concrete in
  the diff.
- **(b) a question or clarification** - answer it in the reply; may need no code.
- **(c) a note not worth acting on** - a judgement call you decline.

The author - human or bot - does not change the triage.

## Address end-to-end

For the actionable threads, follow [[work-on]]'s recipe, driving the sibling
skills rather than reimplementing them. Work one thread's concern at a time.

1. **Fix it test-first, when there is behaviour to test.** A change with a
   testable seam goes through a fresh [[tdd]] cycle - not a patch that skips the
   loop. One behaviour at a time. A change with no seam to test - docs wording, a
   config value, a comment or rename, formatting - is made directly; do not
   invent a test for it. Say which path you took.
2. **Run the repo's mechanical checks.** Before committing, get the project's
   formatter, linter, and type-checker clean, however this repo runs them.
3. **Commit the fix.** Record each fix as a focused follow-up commit via
   [[git-committing]] - Conventional Commits, on the PR's branch.
4. **Review, proportionally.** For a behaviour change, put the updated diff
   through [[code-review]] and [[security-review]] and drive the
   review-fix-re-review loop to sign-off, as [[work-on]] does. A trivial fix - a
   typo, a rename, a one-line correction - does not need both reviews; use
   judgement and say what you ran.

## Reply

For each **review thread**, once its concern is handled, reply - and stop there.
Do not resolve the thread; leave that to the reviewer.

Reply with what was done (name the fix commit), or - for a declined note - why
not. Reply to the thread by replying to its first comment's `databaseId`:

```bash
gh api --method POST \
  repos/<owner>/<repo>/pulls/<number>/comments/<comment_databaseId>/replies \
  -f body='Fixed in <sha>: <short description>.'
```

For top-level **conversation comments**, reply with `gh pr comment <number>
--body '...'`.

## Push

Push the follow-up commits to the PR branch:

```bash
git push
```

The skill stops here. It does not merge the PR and does not change any ticket's
status - that belongs to merge (see [[work-on]]).

## Guardrails

- NEVER add an agent co-author trailer, attribution, generated-by credit, or
  session link to a reply body or a commit.
- Never resolve a thread - replying is where this skill stops. Resolving is the
  reviewer's call.
- A declined comment gets a reply saying why - never silence.
- Assumes `gh` is authenticated. If `gh auth status` fails, stop and ask the user
  to run `gh auth login`.
- If a comment is ambiguous enough that you would have to invent a decision to
  act on it, stop and ask the user rather than guessing.

## Completion

Done when every unresolved thread has been either addressed - fix committed,
pushed, replied - or explicitly declined with a reply, any conversation comments
have been answered, the repo's checks are clean, and the reviews that ran came
back signed off. Threads are left open for the reviewer to resolve. Report the
PR URL, each comment's disposition, the fix commit SHAs, and the final test and
check results.
