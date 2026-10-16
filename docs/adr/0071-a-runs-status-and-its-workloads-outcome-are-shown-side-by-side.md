# 0071. A run's status and its workload's outcome are shown side by side

## Status

Accepted

## Context

A run's status says only whether its harness finished cleanly. Whether the work landed is a separate outcome: a dispatch is done or failed (ADR-0065), a revision ends ok or error with a reason (ADR-0062). Revision 8 on #477 ran `success` while its revision ended `error`, and the runs list and run page showed only `success`, so the operator read a give-up as a success.

- Option 1: Keep the run status as the harness result, and show the dispatch, revision or conflict resolution outcome and its reason next to it on the runs list and run page.
- Option 2: Fold the outcome into the run status, so a run whose workload failed shows as failed.

## Decision

We will go with Option 1. The run status keeps meaning "the harness finished cleanly", and the outcome is always shown beside it wherever the run status appears, so `success` never stands alone for a workload with an outcome.

## Consequences

A run can read `success` with a failed outcome next to it, and the operator can tell which of the two broke. Every page that shows a run's status also has to load its outcome. The attempts page stops being the only place a revision's state is visible.
