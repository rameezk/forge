# 0082. A refused close is retried by the settle step

## Status

Accepted

## Context

Under ADR-0066 a failed dispatch closes the pull requests forge left. GitHub can refuse or error on that close, and once a ticket is `forge:failed` nothing in forge looks at it again.

- Option 1: Keep the dispatch failed with its own reason and only log the refused close. The reason stays true, but the pull request stays open forever and a retry leaves two open forge pull requests, the case ADR-0066 exists to prevent.
- Option 2: End the dispatch as `errored`, as a failed after-run pull request lookup does. The close failure is visible, but the real reason, such as a failing check, is lost.
- Option 3: Keep the dispatch failed with its own reason, close before relabelling, and on a refused close leave the ticket `forge:running` so the shared settle step retries the close on the next dispatch pass or frontier sync, then relabels it `forge:failed`.

## Decision

We will go with Option 3. The close runs before the comment carrying the fixed note, and a comment GitHub refuses after a successful close is only logged, since a retry would no longer find the closed pull request.

## Consequences

The recorded reason stays true and the close eventually happens through a retry path forge already has. A close that keeps failing, such as after a revoked permission, leaves the ticket `forge:running` with a log line every pass until an operator fixes it. A pull request can rarely end up closed without its note.
