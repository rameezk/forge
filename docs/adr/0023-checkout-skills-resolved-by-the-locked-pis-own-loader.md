# 0023. Checkout skills are resolved by the locked pi's own loader, and skill directories stay inside the checkout

## Status

Accepted

Refines ADR-0018.

## Context

ADR-0018 has the runner find a `/<name>` skill in the checkout before pi starts. pi 0.75.4 names a skill by its frontmatter, searches skill directories recursively, loads markdown files at their root, honours `.gitignore`, `.ignore` and `.fdignore` inside them, and follows symlinks. When two files load under one name, it keeps the first in `--skill` order and reports the collision only as a diagnostic that the run never sees. So the runner can only say which skill runs by agreeing with pi exactly, and a link nested in a skill directory can reach outside the checkout.

- Option 1: Check only `<skill dir>/<name>/SKILL.md`. Simple, but it refuses skills pi loads and misses collisions pi resolves silently.
- Option 2: Copy pi's discovery rules into the runner. A first copy already diverged from pi on dot files, non-string names and ignore files, and every pi upgrade would need a manual re-check.
- Option 3: Call `loadSkills` from the pi-coding-agent package that forge's nixpkgs locks, the one the pi CLI contract check runs, with the same skill paths the runner passes.
- Option 4: Depend on pi-coding-agent through npm. pi's published `npm-shrinkwrap.json` lists its sibling packages without integrity, which the Nix npm fetcher rejects.

## Decision

We will go with Option 3.

- `forge-dispatch` imports `loadSkills` from the package named by `FORGE_PI_PACKAGE`, which the runner's Nix wrapper sets to nixpkgs' `pi-coding-agent`.
- A `/<name>` prompt is refused before pi starts when pi loads no skill under that name, or when more than one distinct file loads under it. The refusal names those files.
- Before that, the runner walks every skill directory it passes. It refuses the dispatch if any symlink under one resolves outside the checkout, or if a directory link leads to a directory that holds another directory link. pi's loader follows links with no cycle guard, so a loop, or a chain whose links multiply, would hang it.
- The runner takes a `/<name>` skill command's name up to the first space, as pi does when it expands `/skill:<name>`.
- The test suite, the runner's build check and the dev shell use the same package through `FORGE_PI_PACKAGE`. The contract check passes it to `resolveCheckout` directly.

## Consequences

- Forge's view of a checkout's skills is pi's own, for the locked version. A nixpkgs bump that changes pi's loader changes forge's view with it, and the contract check runs that version end to end.
- The runner now depends on pi's library API (`loadSkills` and its collision diagnostic), not only its CLI.
- A checkout whose skills link outside it, or nest directory links, cannot be dispatched, even when pi would load nothing harmful through the link. One skill directory linked into another is still allowed.
- Only the prompted name is checked for ambiguity. A collision under another name, such as a skill the prompted one delegates to, still resolves to pi's first pick.
- Subagents run pi's loader again on the same skill paths later in the run, after the run may have changed the checkout. That is the run-writable state ADR-0015 already accepts for subagents.
- The runner still does not see the pi binary an operator configures. It sees the locked package, as the contract check does.
