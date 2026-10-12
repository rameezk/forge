# 0055. Each harness adapter owns everything harness specific

## Status

Accepted

Amends ADR-0008.

## Context

ADR-0054 adds Claude Code as a second harness. The `Harness` interface from ADR-0008 yields harness-neutral `HarnessEvent`s, but pi leaks through it: the runner opens pi's agent dir for every run, the fingerprint and frontend parse the request records pi's `pi-request-record` extension writes, skill loads are inferred from pi's `read` tool and its truncation footers, and the workload hard-codes the `pi` harness.

- Option 1: Make the interface fully harness neutral. Each adapter owns its per-run state, turns its own request capture into one harness-neutral request record, and emits skill loads as `HarnessEvent`s, and harnesses are looked up by name.
- Option 2: Add a Claude Code adapter beside pi and branch in the runner wherever the two differ.

## Decision

We will go with Option 1. The runner, fingerprint, store and frontend know nothing about which harness ran a workload beyond its name and version.

## Consequences

A further harness is one new adapter. Moving pi's specifics behind the interface touches the runner, fingerprint and frontend request-record reader before Claude Code can run. Each adapter must map its capture onto the shared request record, so a harness that cannot expose its system prompt and tools cannot be fingerprinted.
