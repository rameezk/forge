# 0045. The runner enforces a workload's limits and fails closed on unpriced spend

## Status

Accepted

## Context

ADR-0044 hard-stops a workload over its budget or timeout. Something has to measure spend and time and do the stopping. Billed cost arrives about a minute after each generation; the runner's estimate arrives at once but is missing when the model's list price is unknown, and the run total today counts such a generation as nothing.

- Option 1: systemd's `RuntimeMaxSec` stops the unit. Covers time only, and the run ends `interrupted` rather than `exceeded`.
- Option 2: The runner tracks both limits itself, checking spend after each generation, and counts unpriced generations as free.
- Option 3: As Option 2, but a budgeted workload must have a known list price to start, and a generation with neither a billed cost nor an estimate ends it as `exceeded`. A systemd `RuntimeMaxSec` backstop stops a runner that hangs.

## Decision

We will go with Option 3. Spend is each generation's billed cost where known and its estimate otherwise, subagents included, checked after every generation. The timeout counts from the harness's start, so checkout and devShell setup do not use it, and the backstop sits 30 minutes past it to cover that setup. A dispatch unit is named for its ticket, not its worker, so every dispatch unit shares one backstop from the longest timeout of any dispatching worker, and none when any of them is unlimited. The limits are a global default of 5 USD and 2 hours with per-worker overrides, where `null` means unlimited, and each run records the limits it ran under. The agent is not told its limits, so they stay out of the config fingerprint.

## Consequences

A budget cannot be silently bypassed by a model forge cannot price. Because spend is checked between generations, a workload can overshoot its budget by its in-flight generations, more with concurrent subagents. A backstop kill ends the run `interrupted`, which is accurate for a runner that failed to stop its own workload.
