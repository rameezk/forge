# 0073. Forge's credential tools come before the dev shell

## Status

Accepted

Amends ADR-0027. Builds on ADR-0025.

## Context

Forge's `gh` is a script that reads the token file from ADR-0025 into `GH_TOKEN` and runs a pinned `gh`. ADR-0027 puts the repository's dev shell `PATH` before the toolset, so a dev shell that ships its own `gh` hides forge's script. `rameezk/rebind.koplugin`'s does, and a revision of its pull request #98 could not reply or react to the feedback, so it failed as unanswered. git is not affected, because it reads the token through `GIT_CONFIG_*` variables.

- Option 1: A forge-owned directory holding only the script comes before the dev shell, and the script runs forge's pinned `gh`.
- Option 2: The same directory, but the script runs the next `gh` on `PATH`, so the repository's `gh` when it ships one. It needs a `PATH` search, and a repository's `gh` version rarely matters.
- Option 3: The whole toolset comes before the dev shell. This reverses ADR-0027 for every tool.
- Option 4: `GH_TOKEN` in the environment, or a `hosts.yml` forge rewrites. The first breaks ADR-0025, and the second needs a gh config directory that `gh` can write and forge keeps current.

## Decision

We will go with Option 1. A tool that carries forge's credentials is forge's own, not part of the repository's stack, so it comes before both the dev shell and the system `PATH`. Forge's `gh` leaves `forge.runtime.toolset`, so it is always present and an operator cannot remove it.

## Consequences

Every workload, with or without a flake, runs forge's `gh`, and the repository's `gh` is never used. Replacing the toolset no longer affects `gh`. The next tool that carries forge's credentials joins the same directory.
