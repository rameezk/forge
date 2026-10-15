# 0067. The box stays UTC and the dashboard shows times in an operator-set display time zone

## Status

Accepted

## Context

Every timestamp forge stores is a UTC ISO string, and the dashboard renders every time, date filter, and chart day in UTC. An operator outside UTC has no way to read times in their own zone. `config.json` already has a `timezone` key, but it only sets the box's OS clock (`time.timeZone`) and never reaches the dashboard.

Options:

- Option 1: Drive display from the box's OS time zone via the existing `config.json` `timezone`. Couples what the dashboard shows to journald, `nix.gc` scheduling, and the OS clock, and leaves two places that look like they control time.
- Option 2: Keep the box, storage, and all time logic in UTC, and add a display time zone as a typed `forge.runtime.*` option the frontend formats with on the server.
- Option 3: Format times in each viewer's browser zone. Fights the Idiomorph live morph (ADR-0021), which restores server-rendered text, and leaves server-side date filters and chart days without a zone.

## Decision

We will go with Option 2. The box, storage, comparisons, and timers stay UTC. `forge.runtime.dashboard.timeZone` (an IANA name, default `"UTC"`, validated against tzdata at evaluation) sets the zone the dashboard renders in, including date filter boundaries and chart days. The `config.json` `timezone` key is removed, the box is fixed to UTC, and the config loader rejects the old key with a pointer to the new option.

## Consequences

Stored data and logs never depend on a zone setting, and changing the display zone rewrites nothing. Dashboard days follow the display zone, so a chart day can be 23 or 25 hours across a DST change. Operator repositories that set `timezone` fail to evaluate until they move to the new option. Box-side output such as journald and the `forge-frontier` CLI stays UTC.
