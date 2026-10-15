# 0062. Agents run a scoped local pass and leave the full suite to CI

## Status

Accepted

## Context

ADR-0042 had agents run `make check-no-vm` locally before pushing. That target is one `nix build` over every non-VM check with no cap on jobs or cores. On the box, a cx23 with 3.7 GB and no swap, it gets killed for lack of memory, and on the operator's Mac it is very slow. Workers already fell back to narrower checks, as the harness prompt told them to after an exit 137, and mentioned it only in passing. CI runs `make check-no-vm` and every VM test behind the required `ci` check, so it covers everything the local run did.

- Option 1: Keep ADR-0042 and make the full check fit, by capping build parallelism or sizing the box up. Agents keep a full local run, but every change still pays for it, and the Mac stays slow.
- Option 2: Agents run only the commands for the areas they touched, and CI runs the full suite. Workers state which commands they ran, and report a required command that cannot run rather than substitute another.
- Option 3: Agents run nothing locally and rely on CI alone. Fastest locally, but simple breakages surface only after a push and a CI run.

## Decision

We will go with Option 2. Agents never run the full `make check-no-vm`. They run the scoped commands AGENTS.md lists for each area they changed: `npm run typecheck` and `node --test` for a TypeScript package, `tofu test` for `infra/opentofu`, the matching `tests/*.sh` script, or `nix build .#checks.<system>.<check>` for a single nix check. Workers end their report with one line naming the local commands that passed, followed by "full suite: CI". When a required scoped command cannot run, they stop and report it. A change is not done until the required checks on its pull request are green. This is the standing rule, not a stopgap until the full check is faster.

## Consequences

Agents finish faster on the Mac and stop hitting the memory limit on the box. Failures outside the touched areas surface only in CI, after a push. What a worker verified is stated explicitly instead of buried in a side remark. The full check's memory use on the box remains a problem for anyone who runs it there, and is left to the work on speeding it up.
