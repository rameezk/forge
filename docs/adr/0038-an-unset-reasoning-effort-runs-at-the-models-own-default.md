# 0038. An unset reasoning effort runs at the model's own default

## Status

Accepted

## Context

A worker may leave its reasoning effort unset, and the NixOS option documents that as running at the provider default. pi has no thinking level that sends no reasoning parameter for a reasoning-capable model. Without `--thinking` it runs at its `defaultThinkingLevel`, `medium`, and `off` sends `effort: "none"`. pi omits the parameter only for a model marked `reasoning: false`. OpenRouter applies a model's own default reasoning only when the request has no `reasoning` field.

- Option 1: A forge-owned pi extension, loaded in the parent and in every subagent child only when the worker sets no effort, deletes `reasoning` from each provider request through `before_provider_request`. It needs nothing from upstream and works across pi versions, but pi still believes it runs at `medium` and reports that level in its own events.
- Option 2: Add a `--thinking default` level to pi upstream and carry it as a nix patch until a release ships it. The semantics are cleanest and children inherit the flag, but forge depends on upstream accepting it and maintains the patch until then.
- Option 3: Write the model as `reasoning: false` in the per-run `models.json`. It depends on the not-yet-built writer from ADR-0033, contradicts that ADR's reasoning support taken from OpenRouter, and pins pi's own view of the model to `off`.

## Decision

We will go with Option 1. When a worker sets no reasoning effort, the runner loads a small forge-owned extension, separate from the subagent extension, into pi and its subagent children, and it removes `reasoning` from every provider request. When an effort is set, the extension is not loaded and pi receives `--thinking <effort>`.

## Consequences

An unset effort now means the model's own default, so the NixOS option's description becomes true. pi's session events report `medium` for such runs, and forge must not read the effort from them. Subagent children need the extension loaded alongside them, so the child argv carries it even though the subagent extension itself is stripped. A real-pi test against the fake provider guards that unset sends no `reasoning` field and that a set effort sends `reasoning.effort`, for the parent and for a child.
