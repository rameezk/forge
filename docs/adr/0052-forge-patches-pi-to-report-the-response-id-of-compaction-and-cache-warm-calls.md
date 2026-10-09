# 0052. Forge patches pi to report the response id of compaction and cache-warm calls

## Status

Accepted

## Context

pi 1.0.0 makes model calls outside its agent loop: the summary behind each context compaction (two calls when a turn is split, plus any failed retry attempts) and cache-warm requests. Each is a real, billed generation, but pi keeps only its usage and drops its response id, and these calls bypass the provider hooks an extension sees. Forge records none of them, so a workload under-reports tokens and cost and its budget never sees that spend. OpenRouter offers no per-generation listing to find a generation without its id.

- Option 1: Patch pi to carry each such call's response id through `compaction_end` and the cache-warm usage entry. pi's own compaction and warming run unchanged, at the cost of a patch carried through every pi upgrade.
- Option 2: Have forge's extension perform compaction itself through `session_before_compact` and pi's exported `compact()`, capturing ids in its own stream function. No patch, but the extension cannot reach pi's private summarization model, auth, headers, env and retry setup, so it re-implements them and can silently drift from pi; it couples to `compact()`'s arguments without a build failure on change; and it cannot see cache warming at all.
- Option 3: Record each call with no id at forge's estimated cost, as a new kind of row billing can never confirm. No patch, but the spend is never billed and the run's cost is permanently an estimate.

## Decision

We will go with Option 1. Forge's pi package patches compaction and cache warming to report the response id of every model call they make, failed attempts included, and forge records each as an ordinary generation, billed, budgeted and settled like any other. The patch also gives compaction's model calls pi's payload hook, so the request record captures them like any other request.

## Consequences

Compaction and cache-warm spend reach a workload's totals, its budget check and billing, a subagent's under that subagent and a subscription run's at its list-price equivalent. A call that still arrives without an id takes the existing no-id path: estimated, given up, and the run unconfirmed. Forge does not offer the change upstream, so every pi upgrade has to re-apply the patch, and the build fails if it no longer applies.
