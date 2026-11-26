# 0127. Forge ships operator skills through a forge-owned operator shell

## Status

Accepted

## Context

Forge is to give operators skills, starting with one that onboards a managed repository. The forge bump moves the operator repository's `forge` input but never merges template files, and the template's devShell lists its packages by hand.

- Option 1: Copy the skills into the operator template. They drift behind forge until each operator syncs the template by hand.
- Option 2: Ship them as a Claude Code plugin from the forge repository. Versioned with forge, but usable only from Claude Code.
- Option 3: Forge's flake exports the skills, and a devShell linking them into `.agents/skills` and `.claude/skills` as gitignored links. Added to the template's own `mkShell`, every later addition still needs a template sync.
- Option 4: As Option 3, but forge exports the whole devShell as `forge.lib.operatorShell`, and the template's devShell is that output.

## Decision

We will go with Option 4. `forge.lib.operatorShell` carries the operator standup toolchain and links forge's operator skills into the operator repository when the shell is entered. The links are gitignored and point into the Nix store.

## Consequences

Operator skills and shell tools reach every operator on a forge bump, with no diff in their repository, and work for any agent that reads `.agents/skills` or `.claude/skills`. Each existing operator makes one template edit to adopt `operatorShell`. The skills are present only once the devShell has been entered, and an operator who wants a variant copies a skill under a new name rather than editing forge's. Forge now owns the operator's devShell, so a change to it reaches every operator at their next bump.
