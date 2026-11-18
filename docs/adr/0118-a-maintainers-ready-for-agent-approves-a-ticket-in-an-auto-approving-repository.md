# 0118. A maintainer's `ready-for-agent` approves a ticket in an auto-approving repository

## Status

Accepted

Amends ADR-0079 and builds on ADR-0016 and ADR-0092.

## Context

Every ticket forge dispatches waits for a maintainer to apply `forge:ready`, the approval of ADR-0079, even though the same maintainer already marked it `ready-for-agent`. Across many managed repositories that second labelling is busywork. Forge's App cannot simply apply `forge:ready` itself, since ADR-0079 refuses a ticket whose latest `forge:ready` was not applied by a maintainer.

- Option 1: Keep a maintainer applying `forge:ready`, perhaps in bulk.
- Option 2: Forge trusts its own App's `forge:ready` and separately checks who applied `ready-for-agent`.
- Option 3: In a repository that opts in, a maintainer applying `ready-for-agent` is the approval, with ADR-0079's checks anchored on that event, and forge applies `forge:ready` as a lifecycle marker.
- Option 4: Jev judges whether a ticket is fit to dispatch. It reads text anyone can write, so it can be talked into approving.

## Decision

We will go with Option 3, opted into per repository and off by default. Forge applies `forge:ready` to a `ready-for-agent` ticket that has no `forge:*` label, whether blocked or not, once per maintainer `ready-for-agent` label event and only while that approval stands: the latest `ready-for-agent` came from a maintainer and no one else edited the ticket or its parent spec after it. A ticket whose approval does not stand is left unlabelled, with no failure or comment, and the Board shows it as awaiting re-approval. Forge never re-applies `forge:ready` after `forge:failed`, and a maintainer removing it holds the ticket until a maintainer applies `forge:ready` or `ready-for-agent` again. Opting in labels every existing ticket whose approval stands. A maintainer applying `forge:ready` by hand still approves, as in ADR-0079.

## Consequences

A maintainer approves a ticket once, by marking it `ready-for-agent`, and forge works through the backlog in dispatch order (ADR-0117) while the review limit (ADR-0092) bounds the pull requests waiting on review. Removing `forge:ready` is how a maintainer holds a ticket, and a failed ticket still needs a person to retry it. Writing `ready-for-agent` becomes a decision to dispatch in an auto-approving repository, so tooling that applies it, such as an issue template or `/to-tickets` run by a maintainer, approves work directly.
