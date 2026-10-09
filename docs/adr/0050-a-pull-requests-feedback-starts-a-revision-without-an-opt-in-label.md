# 0050. A pull request's feedback starts a revision without an opt-in label

## Status

Accepted

## Context

Forge should act on review feedback left on its pull requests. ADR-0016 has an operator opt each ticket in with a label, and the same pattern would have a reviewer label a pull request after every review. Forge's own GitHub App identity (ADR-0049) lets it tell feedback from its own activity, so the label is no longer needed to avoid acting on itself.

- Option 1: A `forge:address` label on the pull request starts a revision. Explicit, but every review needs a second manual step.
- Option 2: Each submitted review starts a revision at once. Conversation comments have no submit, so each one would start its own revision.
- Option 3: Any new feedback, reviews and conversation comments alike, starts one revision once none has arrived for a quiet period.

## Decision

We will go with Option 3. Only open pull requests authored by forge's App are watched. The frontier sync polls them for feedback newer than the last revision started from, and the dispatch pass starts a revision once the quiet period has passed and no workload is live on that pull request. A repository opts in by naming a worker in `on.feedback`, beside `on.ticket`, which replaces the repository's single `worker`. Forge passes the worker only the pull request's identity; the worker's prompt or skill reads and judges the feedback.

## Consequences

Reviewing a forge pull request is enough to have it revised, within roughly a quiet period plus a poll interval. Feedback that arrives during a revision waits for the next one. Pull requests opened by people are never touched. Forge holds no opinion on what feedback means, so a repository's skill decides what to change and how to reply. Every operator config naming `worker` on a repository must move to `on.ticket`.
