# 0005. Runtime config surface: a typed NixOS module, separate from config.json

## Status

Accepted

## Context

The agent-workload runtime needs a declarative config surface for its harnesses and workers (a worker is a named `{ harness, model, prompt }` binding). The project already has one config surface: `config.json` (ADR-0002, ADR-0003), read by both OpenTofu and Nix and held byte-for-byte identical across the NixOS toplevel, the OpenTofu plan, and the file itself by the operator repository's divergence guard.

Runtime config differs in kind from what `config.json` holds. It is Nix-only - it configures NixOS services (the runner and the frontend) - and OpenTofu has no interest in it: it is not a provisioning parameter and never reaches the cloud API.

Options:

- Option 1: Extend `config.json` with `harnesses`/`workers`. One familiar file for everything about a box. But `config.json` is jointly owned by two tools, and its divergence guard asserts byte-identical content across both. Adding Nix-only runtime keys forces one of two costs: teach the guard to ignore a subset of the file (weakening its simple "byte-identical" invariant), or make OpenTofu carry a typed interface for fields it never uses. Either entangles unrelated concerns.
- Option 2: A typed NixOS module in the forge library (`forge.runtime.harnesses.*`, `forge.runtime.workers.*`), set in the operator's flake. Nix-only, typed through the module system, evaluated exactly where it is consumed. `config.json` and its guard stay untouched, scoped to provisioning and SSH.

## Decision

We will go with Option 2: runtime config is a typed NixOS module, separate from `config.json`. `config.json` stays scoped to provisioning parameters and the SSH keys the divergence guard protects; harnesses and workers live under `forge.runtime.*` in the library's module and are set in the operator repository's flake.

## Consequences

The operator now configures two surfaces - `config.json` for provisioning, and the `forge.runtime` module options for what runs on the box - so there is no single-file view of an entire deployment, and an operator learns two places. In exchange the divergence guard's byte-identical invariant stays intact and simple, OpenTofu stays free of runtime concerns, and runtime config gains the NixOS module system's typing and defaults that `config.json`'s raw JSON lacks: a malformed worker is a Nix evaluation error, not a silent runtime failure. This is consistent with runtime capability shipping behind the forge library input (harnesses/workers/runner/frontend are library modules), while provisioning config keeps living in the operator repository as ADR-0003 established.
