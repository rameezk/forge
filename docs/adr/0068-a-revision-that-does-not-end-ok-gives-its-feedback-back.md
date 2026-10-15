# 0068. A revision that does not end ok gives its feedback back

## Status

Accepted

Amends ADR-0062.

## Context

A revision moves the pull request's feedback cursor to its start time as soon as it starts. When the answered check on rameezk/forge#414 crashed, the revision ended `error` but the cursor had already passed its feedback, so a rerun found an empty window and ended `ok` without a worker. That breaks ADR-0062's promise that a failed revision is rerun, and recovering meant editing `feedback_watches.cursor` by hand.

- Option 1: Move the cursor only when a revision ends `ok`. The feedback stays due, so the timer retries every tick, and a persistent failure loops and keeps paying for workers.
- Option 2: Keep moving the cursor at start, and when a revision ends anything but `ok`, put the cursor back to its value before the revision and clear `newest` in the same transaction. Nothing retries on its own.
- Option 3: Leave the cursor alone and add a `--since` override to `forge-revise`. Recovery stays manual and the cursor still claims feedback was handled.

## Decision

We will go with Option 2. A revision that ends `error`, `exceeded` or `interrupted`, including a stale `running` revision that a later start marks `interrupted`, restores the cursor it started from and clears `newest`.

## Consequences

A failed revision's feedback is never consumed: the next new feedback, or a manual `forge-revise`, starts a revision whose window again holds every item the failed one was given. A failure does not retry by itself, so a persistent fault costs one run per trigger rather than one per tick. A revision ending `ok` is now the only thing that consumes feedback.
