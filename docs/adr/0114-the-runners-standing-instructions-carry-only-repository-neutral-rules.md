# 0114. The runner's standing instructions carry only repository-neutral rules

## Status

Accepted

## Context

The runner's standing check rule goes into the instruction it hands the harness for every dispatch, revision and conflict resolution, in every managed repository, but it names forge's own setup from ADR-0064: the scoped commands "AGENTS.md lists" and "never the full `make check-no-vm`". In any other repository that target does not exist and AGENTS.md may list nothing, so the agent gets noise at best and, at worst, decides its required instructions are missing and stops.

- Option 1: Keep the forge-specific wording. Forge's agents are unaffected, but every other managed repository gets instructions that do not apply to it.
- Option 2: The runner states only the general rule: run the checks the repository's own instructions name for the areas you changed, never its full suite. Each repository names its own commands.
- Option 3: Drop the check rule from the runner and rely on each repository's instructions alone. A repository that says nothing about checks then gets no "never the full suite" rule.

## Decision

We will go with Option 2. The standing instructions the runner hands the harness name nothing specific to one managed repository, and repository-specific commands live in that repository's own instructions. When a repository names no checks, the agent runs the narrowest checks that clearly fit the change and reports them, rather than stopping. The report line ending in "full suite: CI" stays, since forge already treats the required checks on a pull request as the gate. This narrows how ADR-0064 is carried out, not what it decided.

## Consequences

Forge's own agents lose nothing, because forge's AGENTS.md already names `make check-no-vm` and the scoped commands. Other managed repositories get a rule that holds for them. Future standing instruction text is held to the same bar: forge-specific detail belongs in forge's AGENTS.md, not the runner. Runner tooling every managed repository gets, such as `forge-rerun-ci`, is not repository-specific and may still be named.
