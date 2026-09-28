# 0009. Subagents on pi come from a forge-owned extension, accounted inside the parent workload

## Status

Accepted

## Context

Managed-repository skills (for example `work-on` running `code-review` and `security-review` in parallel) delegate to "sub-agents" in harness-neutral wording. pi has no built-in subagents by design; they come from an extension that registers a tool which spawns child `pi` processes. ADR-0008 makes the adapter own pi's invocation and prices cost from OpenRouter per `responseId` in the parent's stream, which child processes never appear in.

- Option 1: pi's official `subagent` example extension as shipped. Small, but it builds the child argv itself (no `--provider openrouter`, no `--offline`) and only runs named agents from `~/.pi/agent/agents`.
- Option 2: A third-party package (`pi-subagents` by nicobailon, or `@tintinweb/pi-subagents`). Rich, but a large surface for a headless box and tracks pi releases far ahead of the 0.75.4 forge locks.
- Option 3: A minimal forge-owned extension modelled on the official example, loaded by the adapter, whose child invocation and reported usage forge controls.

For accounting, children could either be separate workloads linked to a parent, or part of the parent workload.

## Decision

We will go with Option 3. The extension registers one `subagent` tool taking a single unnamed `{task}`; parallelism comes from several calls in one assistant message, which pi runs concurrently, so the tool must not declare sequential execution. There are no named agents and no chain mode. Children run the same provider, model, thinking level, offline and session-less flags as the parent, without the extension, so nesting is capped at depth 1. The adapter loads the extension with `-e <nix store path>`, leaving no mutable pi home state. Each child's `responseId`s and usage return in the tool result `details`, which pi's `--mode json` emits verbatim in `tool_execution_end`; the adapter prices them through OpenRouter like the parent's own responses and records them in the same workload, tagged as subagent activity.

## Consequences

A workload's cost and transcript include everything its subagents did; a subagent is never a workload of its own. Skills need no pi-specific wording, and code-review's assumption that a sub-agent cannot spawn its own holds on pi. The extension is locked and checked alongside pi, so a nixpkgs bump that breaks the extension API fails a check. Forge maintains the extension itself instead of picking up upstream subagent features; named agents, chains, or per-subagent models would be a new decision.
