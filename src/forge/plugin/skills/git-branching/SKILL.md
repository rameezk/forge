---
name: git-branching
description: Create, name, and manage git branches safely and consistently. Use before starting any code change on the default branch, or when the user or agent asks to start work, create a branch, prepare changes for review or after merging or rebasing-in a branch. Enforces a branch-naming convention and keeps work isolated per branch.
model: sonnet
---

# Git Branching

## Purpose

Give a consistent, safe way to create, name, and manage git branches so work
stays isolated, reviewable, and traceable to its origin.

## When to use

- Before starting any code change while on the default branch
- When the user asks to "start work on", "create a branch", or "prepare a PR"

## Branch naming

Format: `<type>/<short-kebab-description>`

Types: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `spike`

Rules:
- Kebab-case, lowercase, no spaces
- Short but descriptive: `fix/login-token-expiry`, not `fix/bug`
- Prefix with a ticket id when the project uses one: `feat/PROJ-123-add-export`. If using a GitHub issue e.g. `#17` then use branch name: `feat/17-add-export`.

## Workflow

1. Check state: `git status` and `git branch --show-current`. Never assume a
   clean default branch.
2. Sync: `git fetch`, then branch from an up-to-date base.
3. Create and switch: `git switch -c <type>/<name>`.
4. Always create the new branch off the default branch

## Rules

- ALWAYS create new branches from the default branch only.
- ALWAYS ensure the default branch is up to date with remote before creating the new branch.

## Guardrails

- Dirty working tree when asked to branch: stop and report. Don't silently
  stash or discard.

## Cleanup

- After merge, offer to delete the local branch: `git branch -d <name>`
  (use `-d`, not `-D`, to protect unmerged work).
- Prune stale remote-tracking refs with `git fetch --prune` when cluttered.

## Avoid

- Speculative branches created "just in case"
- Reusing an old branch for unrelated new work
- Inventing a naming scheme per task instead of following the convention
