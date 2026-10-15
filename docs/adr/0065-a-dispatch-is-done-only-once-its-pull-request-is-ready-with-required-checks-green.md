# 0065. A dispatch is done only once its pull request is ready with required checks green

## Status

Accepted

## Context

A managed repository's `work-on` skill now opens its pull request as a draft and marks it ready only once every required check is green, so code owners are asked to review only finished work. Forge currently calls a dispatch done when an open pull request closes the ticket and the run was not exceeded, so a draft left by a run that ran out of time waiting on CI, or a pull request left by a run that errored, would count as done.

- Option 1: Keep today's rule. Nothing to build, but a draft or an errored run counts as done.
- Option 2: Require a successful run and a ready pull request, trusting the skill to mark it ready only once checks are green.
- Option 3: Require a successful run and a ready pull request whose required checks are all green, read by forge once when the run ends.

## Decision

We will go with Option 3. Forge reads the pull request's draft flag and its head commit's required checks through GitHub's own required-check flag, so it needs no permission beyond reading checks. Anything short of a successful run with a ready, green pull request ends the dispatch as failed, with the reason recorded.

## Consequences

A done ticket means work ready for review, not just a pull request. Forge does not take the agent's word for it, at the cost of one more GitHub read per dispatch. A run that errors after opening its pull request is no longer done. A repository with no required checks is done as soon as its pull request is ready, and one whose skill opens a normal pull request still works, since that pull request is already ready.
