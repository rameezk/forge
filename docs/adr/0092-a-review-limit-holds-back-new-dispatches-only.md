# 0092. A review limit holds back new dispatches only

## Status

Accepted

## Context

Every successful dispatch leaves a ready pull request waiting on a maintainer's review. Nothing stops forge from opening pull requests faster than they are reviewed. We want to stop that before ticket approval is automated. The only throttle today is `maxConcurrent`, which caps the number of live workloads, not how much review work is outstanding.

- Option 1: Block every workload (dispatches, revisions and conflict resolutions) while the limit is reached. This deadlocks: a full queue of pull requests cannot take in the revisions or conflict resolutions that would let them merge.
- Option 2: Block only new dispatches. Revisions and conflict resolutions keep running on pull requests that are already open.
- Option 3: Count every open pull request in the repository, not just forge's. Forge would need an extra GitHub query each sync, and human pull requests would hold back agent work.
- Option 4: Count only open pull requests. Up to `maxConcurrent` running dispatches can then push the count past the limit.
- Option 5: Count running dispatches plus open pull requests that forge's App opened for dispatches, so the limit is a hard cap.
- Option 6: Set the limit per repository instead of globally. That does not fit a single reviewer spread across repositories.
- Option 7: Enforce the limit only in the dispatch pass. A dispatch started by hand, or two units starting at once, could get past it.

## Decision

We will go with Option 2 and Option 5, as a single global limit set by `forge.runtime.dispatch.maxOpenPullRequests`. It defaults to 5, and `null` disables it. A pull request stops counting only once GitHub reports it merged or closed. We enforce the limit in `startDispatch` alongside `maxConcurrent` and reject Option 7, so a dispatch refused at the limit ends as a failed start. The dispatch pass logs every dispatch that waits on the limit. The Board's In review column header shows the count against the limit and marks the unblocked, `forge:ready`, not-running tickets that the limit is holding back.

## Consequences

Review work in flight never exceeds the limit, and approving tickets ahead of review just queues them. Pull requests already open keep moving, because feedback and conflicts are still worked. A dispatch that fails holds a slot while it runs. A pull request a person turns back into a draft still counts until it is merged or closed. Human pull requests are not limited.
