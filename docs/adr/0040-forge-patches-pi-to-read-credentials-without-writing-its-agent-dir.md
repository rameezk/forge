# 0040. Forge patches pi to read credentials without writing its agent dir

## Status

Accepted

## Context

pi 1.0.0 creates `auth.json` and `models-store.json` in its agent dir and takes a lock directory beside each on every read, even when the key comes from `OPENROUTER_API_KEY`. On the read-only agent dir of ADR-0015 and ADR-0033 it exits on the first credential read. It also re-reads both files throughout the run, and a stored credential beats the env key, so a writable agent dir would let a run change what the running pi does, not only its subagents. pi has no flag or env var to move this state, and upstream closed the matching issue (#6406), saying the lock on read is needed for refresh tokens.

- Option 1: Give pi a writable throwaway agent dir, a tmpfs in the sandbox. No patch, but ADR-0015 and ADR-0033's guarantee holds only while a run already has bash, network and the key, and it silently breaks once #107 narrows that.
- Option 2: Patch pi to use its `ReadOnlyAuthStorage` and an in-memory models store. The agent dir stays read-only, at the cost of a patch carried through every pi upgrade.
- Option 3: Stay on pi 0.75.4. Upstream will not change this, so forge would never upgrade.

## Decision

We will go with Option 2. Forge's pi package patches how pi builds its credential and models stores, so pi never writes or locks anything in its agent dir. The `pi-cli-contract` check runs the locked pi against a read-only agent dir, so an upgrade that loses the patch fails there.

## Consequences

ADR-0015 and ADR-0033 hold unchanged on pi 1.0.0. pi reads `auth.json` once and never sees changes to it mid-run. pi's remote model catalog cache is never persisted, which costs nothing because forge runs pi offline. Every pi upgrade has to re-apply the patch, and the build fails if it no longer applies.
