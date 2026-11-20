# 0121. The Reviewer App writes the forge/auto-merge check run

## Status

Accepted

Builds on ADR-0116 and ADR-0119.

## Context

An auto-merge candidate that `forge-auto-merge` holds back gets a `forge/auto-merge` check run naming why. Only `forge-auto-merge` knows the reason, and it holds only the Reviewer App, which ADR-0116 gave Pull requests and Contents write and Checks read, and no others. Forge's own App, held by the grading service, already has Checks write.

- Option 1: The Reviewer App gains Checks: read and write, and `forge-auto-merge` writes the check run itself. Its ADR-0119 check also verifies the permission and records a missing one as a rule failure.
- Option 2: As Option 1, but a missing permission only skips the check run and logs.
- Option 3: `forge-auto-merge` records the reason in the store and the grading service posts the check run with forge's App, splitting one feature across two services and lagging up to a grading pass.

## Decision

We will go with Option 1. A Reviewer App without Checks write is a rule failure like any other, so `forge-auto-merge` merges nothing in that repository until the operator grants it.

## Consequences

The service that decides an auto-merge is the one that explains it, with no lag and no second writer. The Reviewer App's permissions widen by one, and an existing installation stops auto-merging until the operator grants Checks write, which shows with the other rule failures. A repository failing its rules because of this permission cannot get a check run saying so.
