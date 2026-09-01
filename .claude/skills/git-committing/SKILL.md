---
name: git-committing
description: Create clear, consistent git commits. Use when the user or agent asks to commit work or after finishing a logical unit of change. Enforces a commit-message convention and keeps commits focused.
model: sonnet
---

# Git Committing

## Purpose

Give a consistent, safe way to stage and commit work so history stays clean,
reviewable, and each commit tells a clear and traceable story.

## When to use

- The user asks to "commit", "stage", "save work", or "make a commit"
- After finishing a logical unit of change worth recording

## Message format

Follow Conventional Commits: `<type>(<optional-scope>): <subject>`

Types: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `spike`.

Rules:
- Subject in imperative mood, lowercase, no trailing period: `fix: handle expired login token`
- Keep the subject under ~72 characters
- Add a body when the "why" is non-obvious. Separate it from the subject with a
  blank line. Explain intent and context, not a line-by-line diff.
- Reference issues in the body or footer when relevant: `Closes #17`

## Workflow

1. Check state: `git status` and `git diff` (plus `git diff --staged`) to see
   exactly what will be committed. Never commit blind.
2. Stage deliberately: stage only the files that belong to this change. Prefer
   explicit paths over `git add -A` / `git add .`.
3. Group logically: one coherent change per commit. Split unrelated work into
   separate commits.
4. Commit: `git commit -m "<subject>"` (add `-m` body lines as needed).
5. If the work is related to previous work in the branch, rebase if needed to the commits are presented in a logical and clear order.
6. Report the resulting commit (`git log -1 --oneline`).

## Guardrails

- NEVER commit anything directly on the default branch.
- NEVER add an agent/Claude co-author trailer or attribution to the message. Including any session information.
- NEVER manually edit `CHANGELOG.md` or other auto-generated files as part of a
  commit.
- Dirty or unexpected state (unresolved merge, unrelated staged changes): stop
  and report. Don't silently reset, stash, or amend.

## Avoid

- Vague subjects: `fix: bug`, `chore: stuff`, `update`
- Catch-all commits that bundle unrelated changes
- Committing generated artifacts, secrets, or debug leftovers
- Inventing a per-task message style instead of following the convention
