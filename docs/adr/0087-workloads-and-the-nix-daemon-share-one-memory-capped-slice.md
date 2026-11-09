# 0087. Workloads and the nix daemon share one memory-capped slice

## Status

Accepted

## Context

Each workload unit had its own `MemoryMax`, but two gaps let a workload still cause a box-wide OOM on a box with no swap. Builds that a workload asks the nix daemon for run in `nix-daemon.service`'s cgroup, outside the workload's cap. And every workload gets the full cap, so workloads running at once can together exceed RAM. Deploys build on the box through the same daemon (ADR-0007).

- Option 1: Put every workload unit and `nix-daemon.service` in one slice with a single `MemoryMax`. Any mix of workloads and their builds is bounded together, and memory is shared rather than split statically. Deploy builds share the budget too.
- Option 2: A slice for the workloads and a separate cap on the daemon. Keeps deploy builds apart, but the two caps must be a fixed split of RAM that wastes whichever side is idle, which hurts on a small box.
- Option 3: Cap only the daemon and keep per-workload caps. Closes the build gap but not concurrent workloads adding up past RAM.
- Option 4: Lower nix's `max-jobs` and `cores`. Fewer parallel builds, but no bound on memory.

## Decision

We will go with Option 1. `forge-runner@`, `forge-dispatch@`, `forge-revise@`, `forge-resolve-conflicts@` and `nix-daemon.service` run in one shared slice with one `MemoryMax`, and the daemon gets `OOMPolicy=continue` like the workload units, so an OOM kill takes only the process that was killed. `max-jobs` and `cores` are left at their defaults: the cgroup cap is the guarantee.

## Consequences

An OOM inside the slice kills the slice's largest process and never reaches the box's own services. A workload can still lose a command to another workload's or a build's memory use, since the budget is shared. A deploy that builds while workloads are near the cap can fail its build, which is safe to re-run, or cause a workload's command to be killed. That is accepted: it is weaker than the restart ADR-0035 rules out, and the agent already stops and reports a killed command.
