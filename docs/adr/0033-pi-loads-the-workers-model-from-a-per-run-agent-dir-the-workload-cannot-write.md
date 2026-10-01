# 0033. pi loads the worker's model from a per-run agent dir the workload cannot write

## Status

Accepted

Amends ADR-0015.

## Context

pi does not know every model a worker names. For a model missing from its catalog, pi clones its default OpenRouter model, `moonshotai/kimi-k2.6`, and changes only the id, so it assumes Kimi's 262k context window for compaction and Kimi's output limit. Both live dispatches on 2026-10-01 hit this, with `anthropic/claude-opus-5.5` and `anthropic/claude-sonnet-5.5`. pi reads extra models from `models.json` in its agent dir. ADR-0015 made that dir an empty, read-only store path, because a `models.json` value starting with `!` runs as a shell command, and the run must not plant one. #80 found that registering the model from the forge pi extension replaces pi's whole catalog and does not reach subagents. ADR-0032 already looks up the worker's model on OpenRouter's models endpoint at run start.

- Option 1: The runner writes `models.json` into a fresh agent dir for each run, from the OpenRouter models entry, outside the sandbox. ADR-0024's sandbox binds that dir into the workload read-only. ADR-0015 rejected a per-run dir because the run could write it, which the sandbox now prevents.
- Option 2: Build `models.json` into the store-path agent dir from the operator's worker config, with each worker declaring its model's context window and output limit in nix. ADR-0015 stays untouched, but operators restate numbers OpenRouter already publishes, and they go stale.
- Option 3: Build `models.json` into the store-path agent dir from a snapshot of OpenRouter's models entry fetched at deploy. It stays fixed between deploys, and deploy depends on OpenRouter.

## Decision

We will go with Option 1. At run start, before the sandbox exists, the runner writes the worker's model entry to a per-run agent dir: the model id from the operator's config, and the context window, output limit, reasoning support and prices from OpenRouter's models entry. Only those typed fields are written, never a value taken as a string from OpenRouter, so no value can start with `!`. The workload, pi and its subagents see the dir read-only. If the lookup fails, the dir is written without `models.json`, pi falls back to its default as today, and the run prints a warning.

## Consequences

pi compacts at the model's real context window and its subagents see the same model, because they share the agent dir. ADR-0015's guarantee still holds: nothing a run writes changes what pi loads in that run or a later one. Its mechanism changes, though: the agent dir is no longer a store path, and it now relies on ADR-0024's sandbox to stay read-only. The run's start now depends on the same OpenRouter models lookup that ADR-0032 adds, and a failed lookup degrades to today's behaviour instead of failing the run. This is also where provider pinning would go if cache misses turn out to come from OpenRouter switching providers.
