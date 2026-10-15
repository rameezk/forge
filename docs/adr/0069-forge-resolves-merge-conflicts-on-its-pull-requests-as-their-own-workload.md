# 0069. Forge resolves merge conflicts on its pull requests as their own workload

## Status

Accepted

## Context

Forge runs several tickets at once, and sibling tickets often touch the same files, so merging one forge pull request regularly leaves another conflicting with the default branch. Nothing in forge notices: the pull request sits unmergeable until a person resolves it. Revisions (ADR-0050, ADR-0062) already run a worker on a pull request's own branch, but they are driven by feedback, a cursor, a quiet period and a check that every item was answered, none of which a conflict has.

- Option 1: Treat a conflict as a synthetic feedback item for the existing revision. Nothing new to configure, but it bends the feedback cursor and the answered check around something no person wrote.
- Option 2: A separate workload kind on the pull request's branch with its own trigger, worker, success check and record, sharing the revision's watched pull requests and run-on-branch plumbing.

Within Option 2:

- Trigger on a conflicting pull request only, rather than also on one that is merely behind or one whose merge result breaks. Behind is what GitHub's update branch or a merge queue is for, and a broken merge result is a red-check problem with a far wider surface.
- Merge the default branch into the pull request's branch, rather than rebase and force-push, which would rewrite commits reviewers have seen, orphan inline comments and rewrite rework.
- Opt in per repository with its own worker, rather than reusing the feedback worker or running for every repository with `on.ticket`, since it needs its own prompt and skill and costs money.

## Decision

We will go with Option 2, a conflict resolution. Forge watches the same pull requests as for feedback: open, authored by its App, drafts included, and with no live workload. When GitHub reports one as conflicting, forge starts a conflict resolution in the shared `dispatch.maxConcurrent` pool, ahead of any revision also due on that pull request. Before the harness starts, forge trial-merges the default branch in the run directory: a clean merge ends the conflict resolution ok without a worker, and a conflicting one is aborted and handed to the worker a repository names in `on.conflict`, with the pull request, the default branch and the sha to merge, and the conflicting files. The worker merges that sha in and never force-pushes. It is done only when forge reads the new head as containing that sha, not conflicting with it, and with every required check green, the bar ADR-0065 sets for a dispatch; the default branch moving on during the run is a new trigger, not a failure. Each attempt is keyed on the pull request's head and the default branch's head, and a failed attempt is retried only when either moves or when run by hand with `forge-resolve-conflicts`. A failed conflict resolution leaves the pull request open and untouched.

## Consequences

A forge pull request left conflicting by a sibling's merge is brought back to mergeable without a person, and the revision's feedback contract stays untouched. A repository opting in must carry a skill for resolving conflicts on its branch and its operator must name a worker for it. A stale conflicting flag costs a clone and a trial merge, not a worker. A pull request that is behind but not conflicting, or whose merge result breaks without conflicting, is still left to people, and one whose conflict resolution failed stays open for a person to take over, its failure shown only on the dashboard. A persistent failure costs one run per movement of either branch, not one per poll.
