# 0031. A run whose runner stops heartbeating ends as interrupted

## Status

Accepted

Amends ADR-0013.

## Context

A run's end state is written only when the runner finishes it. In the first live dispatch the unit was OOM-killed, so the run stayed `running` with no end time, its cost stayed `pending` despite every recorded generation being billed, and after 24 hours it became `unconfirmed` while still showing as running forever. Only dispatches had a liveness signal, and only the next dispatch acted on it. A generation id is recorded only after its response completes, so a killed runner may leave billed generations unrecorded.

- Option 1: Ask systemd whether the run's unit is alive. Needs D-Bus access from hardened units and cannot tell manual runs apart, since `forge-runner@` is named per worker, not per run.
- Option 2: Close the run from the existing dispatch heartbeat. Manual runs stay uncovered.
- Option 3: The runner heartbeats on the run row itself, and the billing timer ends any running run whose heartbeat is stale as `interrupted`, with an `unconfirmed` cost.
- Option 4: As Option 3, but let the cost settle to `billed` once every recorded generation is billed. Claims more certainty than forge has.

## Decision

We will go with Option 3. The runner refreshes `runs.alive_at` every 20 seconds. Each minute the billing service ends any `running` run whose heartbeat, or start time where it has none, is over 120 seconds old: status `interrupted`, end time at its last heartbeat, an error naming when it was last seen, and the given-up generation that marks later generations as possibly unrecorded, so its cost is `unconfirmed` at once. The frontier sync also settles stale dispatches and their `forge:*` labels on each poll, as dispatch already does.

## Consequences

A killed run shows as interrupted within about three minutes, with what was billed shown as unconfirmed, and its ticket leaves `forge:running` on the next poll rather than on the next dispatch. Manual runs are covered the same way. The 24-hour give-up for a run that never ended is no longer how a killed run is found, and the transcript of an interrupted run is left as pi wrote it.
