# 0125. An assigned ticket is left to its assignee

## Status

Accepted

## Context

An operator wants to take a ticket off forge's hands and work it with an agent on their own machine. Forge's own claim is the `forge:running` label (ADR-0016), so a person working a ticket locally needs a marker forge respects, or forge may dispatch the same ticket.

- Option 1: Forge tracks local work as a kind of workload, with the local agent reporting progress and cost to the box. Needs a write path into the box and gives up the isolation and recording every workload has.
- Option 2: A new `forge:local` label. Explicit, but overloads forge's lifecycle labels with a human state and is only set by people who know about it.
- Option 3: Any assignee on the ticket's issue. GitHub's native meaning of "a person has this", set by any tool or by hand, and gated by GitHub to triage permission or higher.

## Decision

We will go with Option 3. Forge neither dispatches nor auto-approves a ticket whose issue has any assignee, whoever it is, and records nothing about the work done on it. Assigning a ticket while forge is running it does not interrupt the live dispatch; it only stops the next one. Revisions and conflict resolutions on a pull request forge opened are unaffected.

## Consequences

Claiming and releasing a ticket is assigning and unassigning it, visible wherever GitHub shows assignees. Teams that assign issues for planning will silently keep those tickets from forge, so the Board has to show an assigned ticket as held by its assignee. An assignee only makes forge do less, so trusting any assignee, not just maintainers (ADR-0078), cannot make forge act for anyone. Work done locally has no trace, cost or outcome in forge.
