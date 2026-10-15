# 0068. Forge enforces the ready status labels it reads

## Status

Accepted

## Context

The Board reads a ticket's stage from `ready-for-refinement`, `ready-for-agent` and `ready-for-human` as well as forge's own `forge:*` labels. The status labels are created by the managed repository's skills, create-only, so their styling varies by repository: `ready-for-refinement` exists in some as grey, and the to-tickets defaults give `ready-for-agent` the same green as `forge:done` and `ready-for-human` the same yellow as `forge:running`, so on GitHub a ticket that is merely ready looks like one forge is running or has finished.

- Option 1: Leave the status labels to the repositories, create-only, and only read them.
- Option 2: Forge ensures all three at every sync the way it ensures `forge:*` (ADR-0016), creating each if missing and overwriting its colour and description if they differ: `ready-for-refinement` `#D4C5F9`, `ready-for-human` `#F9D0C4`, `ready-for-agent` `#C2E0C6`.

## Decision

We will go with Option 2. The status labels take pale shades so none shares a colour with a saturated `forge:*` lifecycle label, and the to-tickets skill's create defaults match them.

## Consequences

Every managed repository shows the same label styling forge's Board relies on, and a repository that already styled these labels loses its colours and descriptions on the next sync. An operator who restyles one by hand sees it reverted.