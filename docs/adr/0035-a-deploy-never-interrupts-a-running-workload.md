# 0035. A deploy never interrupts a running workload

## Status

Accepted

## Context

A deploy killed a running dispatch. `nixos-rebuild switch` restarts any unit whose definition changed, and almost every deploy changes `forge-dispatch@` and `forge-runner@`, since the runtime package is in their `ExecStart`. The workload's spend so far is lost, and the ticket needs relabelling to run again.

- Option 1: Mark both workload units `restartIfChanged = false` and `stopIfChanged = false`, so a running instance finishes on what it started with and only later instances get the new configuration. Declarative and never blocks a deploy.
- Option 2: `just deploy` waits or refuses while a workload is running. The box always runs current code, but a long run blocks an urgent fix, and the check lives in imperative deploy tooling.
- Option 3: Let the deploy kill it and re-dispatch afterwards. Wastes the spend so far and needs restart and resume machinery.

## Decision

We will go with Option 1 for `forge-dispatch@` and `forge-runner@`. The billing and frontier-sync oneshots keep the default, since a killed instance simply runs again on its next timer tick.

## Consequences

A running workload keeps the package, configuration and secrets it started with until it ends, so a fix, security fixes included, reaches it only if the operator stops it with `systemctl stop`, which settles it as interrupted. The previous version can be writing to the store while the new one migrates it, so store migrations must stay compatible with the version before them, which in practice means additive. A deploy that removes a workload template entirely still stops its running instances, which is accepted as a deliberate operator act.
