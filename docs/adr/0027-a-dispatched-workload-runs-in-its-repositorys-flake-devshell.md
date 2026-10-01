# 0027. A dispatched workload runs in its repository's flake devShell

## Status

Accepted

Amends ADR-0024.

## Context

A dispatched workload runs the repository's own tests and checks, so it needs that repository's stack. The base toolset is shared by every workload, and managed repositories will use different stacks.

- Option 1: Operators extend the shared toolset. Every repository gets the union of all the stacks, and versions can conflict.
- Option 2: A per-repository `toolset` option in forge's config. It duplicates the repository's devShell and drifts from it.
- Option 3: The repository's flake devShell. The repository declares its own stack, as it already brings its own skills (ADR-0018), and it is what the operator uses locally.

For who enters the devShell:

- Option A: The runner, through `nix print-dev-env`, before pi starts. pi and its subagents inherit the environment, and a broken devShell fails the dispatch before pi starts.
- Option B: The agent, through `nix develop -c` in each command. Each command pays for flake evaluation, and the repository's instructions must know to do this.

## Decision

We will go with Option 3 and Option A, using the flake's default devShell. Repositories without a flake get only the base toolset. The sandbox from ADR-0024 also binds the nix daemon socket, so the agent may use nix itself, `nix run` included. `forge-runtime` must never be a trusted nix user.

## Consequences

A repository changes its stack the same way it does for local development. One workload cannot plant a tool for a later one through the store, because builds run in nix's own sandbox and an untrusted user cannot add unsigned paths or change substituters. That guarantee stops holding if `forge-runtime` ever becomes trusted. The agent can use the box's disk and network through the daemon. The devShell's variables also reach pi itself, so a repository's flake can affect the harness as well as the agent's tools.
