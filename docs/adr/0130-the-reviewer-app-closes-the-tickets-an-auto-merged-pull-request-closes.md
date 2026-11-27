# 0130. The Reviewer App closes the tickets an auto-merged pull request closes

## Status

Accepted

Builds on ADR-0116 and ADR-0121.

## Context

When the Reviewer App merges a pull request, GitHub leaves the tickets it closes open: #954, merged by the Reviewer App, left #952 open with `ready-for-agent` and `forge:done`, so the frontier showed it as ready again. Every maintainer merge closed its tickets. The Reviewer App has no Issues permission, and `forge-auto-merge` holds nothing of forge's App (ADR-0116).

- Option 1: The Reviewer App gains Issues: read and write, its `review` token asks for it, and `forge-auto-merge` closes the pull request's still-open closing issues in the same repository right after the merge, recording any close it owes and retrying it each pass until it succeeds. An installation without the permission cannot mint the token, which is a rule failure like ADR-0121's.
- Option 2: A service holding forge's App, such as the frontier sync, closes the still-open closing issues of merged forge pull requests on its pass, splitting the feature across two services with up to a pass of lag, the shape ADR-0121 rejected.
- Option 3: `forge-auto-merge` is also given forge's App key, breaking ADR-0116's isolation.
- Option 4: The Reviewer App gains Issues write and forge relies on GitHub's own auto-close, which GitHub does not document for a merging App.

## Decision

We will go with Option 1. Forge closes the issues itself as `completed` without a comment and leaves their labels, whether or not GitHub would also close them, and a ticket closed once is never closed again, so a maintainer's reopen stands.

## Consequences

The service that merges is the one that finishes the merge's effects, with no lag and no second writer. The Reviewer App's permissions widen by one, and an existing installation stops auto-merging until the operator grants Issues: read and write, which shows with the other rule failures. The Reviewer App can change issue state and labels, but ADR-0068 already strips status labels applied without write access. A closed ticket's timeline names the Reviewer App rather than the pull request, which its Development sidebar still links.
