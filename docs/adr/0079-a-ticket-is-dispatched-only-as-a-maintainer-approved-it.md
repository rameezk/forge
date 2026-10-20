# 0079. A ticket is dispatched only as a maintainer approved it

## Status

Accepted

## Context

On a public repository anyone can open an issue or comment on one. Forge dispatches any ticket carrying `ready-for-agent` and `forge:ready` without asking who applied them, and the agent reads the ticket, its comments and its parent spec live with `gh`. An issue template that applies both labels dispatches a stranger's issue, an author can rewrite an issue after a maintainer labelled it, and any stranger's comment reaches the model.

- Option 1: Only dispatch tickets a maintainer (ADR-0078) opened. Simple, but a maintainer cannot approve a stranger's good issue.
- Option 2: Snapshot the ticket when `forge:ready` is applied and hand the agent only the snapshot. Needs storage, and the agent can still read the live issue.
- Option 3: Treat a maintainer applying `forge:ready` as approval of the ticket and its parent spec as they stood at that moment. Dispatch refuses when the latest `forge:ready` was not applied by a maintainer, or when anyone else edited the title or body of the ticket or its parent spec after it. Forge builds the ticket's context itself, with only maintainers' comments, and embeds it in the instruction.

## Decision

We will go with Option 3. Dispatch reads the timeline's `LabeledEvent`, `RenamedTitleEvent` and `UserContentEdit` records for the ticket and its parent spec. A refused ticket swaps `forge:ready` for `forge:failed` and gets one fixed comment, "Forge needs a maintainer to re-approve this ticket: it was approved or changed by someone without write access.", alongside the single failure comment of ADR-0077. Re-applying `forge:ready` after reviewing the change approves it again. The instruction carries the title, body and maintainer comments of the ticket and of its parent spec, and the skills work from it rather than fetching the issue or a pull request's comments themselves.

## Consequences

Only text a maintainer wrote or approved is handed to the agent, and auto-labelling issue templates no longer dispatch anything. A maintainer must re-approve whenever an outsider edits an approved ticket or its spec. Filtering is defence in depth rather than enforcement, since the workload token can still read the whole issue; limiting what a compromised run can do is left to a separate decision.
