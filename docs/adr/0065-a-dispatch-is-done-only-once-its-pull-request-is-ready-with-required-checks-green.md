# 0065. A dispatch is done only once its pull request is ready with required checks green

## Status

Accepted

## Context

A pull request is complete once it is ready for review with every required check green, and only then should code owners be asked to review it. A managed repository's own skills decide how a run gets there, for example by opening a draft and marking it ready once its checks are green. Forge currently calls a dispatch done when an open pull request closes the ticket and the run was not exceeded, so a draft, a pull request whose checks are still running or red, or one left by a run that errored all count as done.

- Option 1: Keep today's rule. Nothing to build, but done does not mean complete.
- Option 2: Require a successful run and a ready pull request, and count pending checks as done. Skills that end before CI finishes keep working, but a done pull request can still go red.
- Option 3: Require a successful run and a ready pull request whose required checks are all green, read by forge once when the run ends.
- Option 4: Option 3 behind a per-repository setting. Flexible, but leaves forge's own meaning of done to operator config.

## Decision

We will go with Option 3, as a contract every managed repository's skills must meet: by the time the run ends, it has left a ready pull request closing the ticket with every required check green. Forge does not care how a skill gets there. It reads the pull request's draft flag and its head commit's required checks through GitHub's own required-check flag, so it needs no permission beyond reading checks. Anything short of that ends the dispatch as failed, with the reason recorded.

## Consequences

A done ticket means work ready for review, not just a pull request, and forge does not take the agent's word for it, at the cost of one more GitHub read per dispatch. A skill that ends its run before the required checks are green, or leaves its pull request a draft, now fails, with the draft or the pending or red check named so the operator can see what to change. A run that errors after opening its pull request is no longer done. A repository with no required checks is done as soon as its pull request is ready.
