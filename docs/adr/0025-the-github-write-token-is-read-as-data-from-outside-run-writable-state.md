# 0025. The GitHub write token is read as data from outside run-writable state

## Status

Accepted

Refines ADR-0017.

## Context

ADR-0017 has the operator place the write token by hand as an EnvironmentFile, like the OpenRouter key. A file systemd loads into a unit's environment can set any variable, and a file in `/var/lib/forge` can be written by a run. A run could then plant variables like `NODE_OPTIONS` into every later forge process, which ADR-0015 forbids.

- Option 1: Load the token as an EnvironmentFile from the state directory, as ADR-0017 says. Simple, but it breaks ADR-0015.
- Option 2: Load it as an EnvironmentFile from a directory no unit can write. Systemd still passes every variable in the file, so the operator's file decides more than the token.
- Option 3: Keep the file in EnvironmentFile format, `github-write.env`, in `/var/lib/forge-credentials`, outside the run-writable state directory. Systemd never loads it. Forge reads only `GITHUB_TOKEN` from it as data and puts that alone in the agent's environment.

## Decision

We will go with Option 3. tmpfiles creates `/var/lib/forge-credentials`, no unit can write it, and it is masked from the units that never need the token: the scheduled runner, billing and the dashboard.

## Consequences

Nothing a run writes changes what a later run loads, as ADR-0015 requires. The dispatch units read the token in forge's code rather than in their unit definitions, so a unit file alone no longer shows which secrets it holds. Every unit still runs as `forge-runtime`, so a scheduled run can read the token through `/proc` of a dispatch or the frontier sync until ADR-0024's confinement is built.
