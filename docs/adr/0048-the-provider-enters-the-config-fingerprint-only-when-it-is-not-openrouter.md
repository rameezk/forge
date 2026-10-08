# 0048. The provider enters the config fingerprint only when it is not OpenRouter

## Status

Accepted

Amends ADR-0034.

## Context

ADR-0046 gives each worker a provider. On the `anthropic` provider pi adds a Claude Code identity line to the system prompt and renames its tools, and ADR-0047 costs the run at a list-price equivalent instead of billed cost, so a provider switch changes behaviour and what cost means. The fingerprint hash covers every key of the snapshot, so adding a field changes the hash of every workload recorded after it.

- Option 1: Always record `provider` in the hashed snapshot. Every existing worker starts a new cohort at the deploy that adds it, though nothing about it changed.
- Option 2: Record `provider` in the hashed snapshot only when it is not `openrouter`. Existing cohorts continue, at the cost of one special case in the hash.
- Option 3: Leave `provider` out. The model id and system prompt hash already differ between providers, but the cohort diff does not name the cause.

## Decision

We will go with Option 2. A workload on `openrouter` hashes as before, and one on any other provider carries `provider` in its hashed snapshot. The cohort page shows the provider for every workload, defaulting to `openrouter` where the snapshot omits it.

## Consequences

Switching a worker's provider starts a new cohort whose diff names the provider. OpenRouter cohorts recorded before the provider existed continue unbroken. If the default provider ever changes, the omitted value still means `openrouter`, not the new default.
