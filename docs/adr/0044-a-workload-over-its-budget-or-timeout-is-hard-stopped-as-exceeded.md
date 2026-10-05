# 0044. A workload over its budget or timeout is hard-stopped as exceeded

## Status

Accepted

## Context

Nothing bounds how long a workload runs or how much it spends, and some run long enough to cost a lot. Forge needs to end such a workload and say why.

- Option 1: Hard stop. On crossing a limit, kill the workload, its subagents included, at once.
- Option 2: Soft then hard. Ask the agent to wrap up, then kill it after a grace period. Needs a mid-run message the harness may not support, and the agent keeps spending while it wraps up.
- Option 3: Hard stop, then forge pushes or comments on what the run directory holds. Puts git work in forge that belongs to the agent.

For the end state, reusing `interrupted` would claim the runner died, and reusing `error` would claim the harness failed.

## Decision

We will go with Option 1. A workload has two independent limits, a cost budget in USD and a wall-clock timeout, and crossing either hard-stops it. It ends in a new run status, `exceeded`, recording which limit it crossed, `budget` or `timeout`. There are no token or turn limits. A dispatched workload that ends `exceeded` is a failed dispatch labelled `forge:failed`, and forge posts no cost back to the ticket.

## Consequences

Spend and duration are bounded, at the price of losing whatever the agent had not yet pushed; the run directory is kept as an artifact as usual. Retrying stays manual. A graceful wrap-up would be a new decision.
