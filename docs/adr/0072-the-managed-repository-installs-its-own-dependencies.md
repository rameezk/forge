# 0072. The managed repository installs its own dependencies

## Status

Accepted

## Context

A run's checkout has no installed dependencies. The forge repository's scoped checks need `npm ci` first, and four runs on #477 did that unprompted. Revision 8 did not: it read the missing `node_modules` as a required command that cannot run, stopped under ADR-0064, and left its fix unpushed.

- Option 1: The managed repository says how to install, in AGENTS.md, and forge's injected rule says a missing install is something to fix, not a reason to stop. Forge stays repository agnostic.
- Option 2: Forge provisions the run directory by running a setup command the repository declares, in a devShell hook or forge config, before the harness starts. Deterministic, but forge then owns per-repository setup.
- Option 3: Both.

## Decision

We will go with Option 1. Installing dependencies is the managed repository's job, stated in its own instructions, in the same way ADR-0065 leaves how a pull request gets ready to the repository's skills. Forge runs no setup step, and its injected rule tells workers that "cannot run" under ADR-0064 does not cover a dependency install they can do themselves.

## Consequences

Forge's checkout stays a plain clone and needs no per-repository setup contract. Each managed repository has to state its install step, and a worker that ignores it still stops, which the revision's unanswered check or the dispatch's ready check then catches. Every run pays for its own install.
