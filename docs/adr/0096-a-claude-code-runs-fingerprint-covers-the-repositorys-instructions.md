# 0096. A Claude Code run's fingerprint covers the repository's instructions

## Status

Accepted

Amends ADR-0057.

## Context

On pi the repository's `AGENTS.md` or `CLAUDE.md` is appended to the system prompt, so the fingerprint covers it. Claude Code places it in the first user message instead, so on Claude Code an instructions change never starts a new cohort, while skill, settings and hook changes do.

- Option 1: Hash the repository's instructions into the Claude Code fingerprint beside its settings and hooks. Matches pi; repositories with different instructions form separate cohorts, and each instructions edit starts a new one.
- Option 2: Leave them out. Cohorts span repositories and grow larger, but a behaviour change in the instructions goes unnoticed and the harnesses disagree.

## Decision

We will go with Option 1. A Claude Code run's fingerprint carries a hash of the repository's `AGENTS.md` or `CLAUDE.md`, the same file pi would load.

## Consequences

Both harnesses split cohorts on the same repository inputs. A worker serving several repositories with different instructions has one cohort per repository. Instructions change rarely compared with skills, so the added splitting is small.
