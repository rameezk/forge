# 0056. A list-price equivalent is priced from OpenRouter's models entry

## Status

Accepted

Amends ADR-0047.

## Context

ADR-0047 prices a subscription run's list-price equivalent from pi's catalog. Under ADR-0054 subscription runs no longer run on pi, so pi's catalog would be kept only to price them.

- Option 1: OpenRouter's `/models` price for the matching `anthropic/...` model. The same source as OpenRouter runs' estimates, so the two compare exactly, but it needs a mapping from Anthropic model ids to OpenRouter's.
- Option 2: Claude Code's own `cost_usd` on each request. No mapping, but a client-side estimate from a price table forge does not control.
- Option 3: pi's catalog, as today. A Claude Code run then depends on pi being installed just to be priced.

## Decision

We will go with Option 1. A subscription model with no OpenRouter mapping or entry is unpriced, so a budgeted worker on it is refused at start as ADR-0045 already does.

## Consequences

Every run is priced from one source, so cohorts and insights compare subscription and OpenRouter runs on equal terms. A new Claude model needs its mapping before a budgeted subscription worker can use it.
