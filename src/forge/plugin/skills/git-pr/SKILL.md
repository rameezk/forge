---
name: git-pr
description: Prepare and open a GitHub pull request cleanly and consistently. Use when the user or agent asks to open a PR or raise a pull request. Enforces a PR title and description convention.
model: sonnet
---

# Git PR

## Purpose

Give a consistent, safe way to turn a finished branch into a reviewable pull request, with a clear title and a description that explains intent, so reviewers have the context they need.

## When to use

- The user asks to "open a PR" or "raise a pull request"
- A branch has one or more committed changes ready to be reviewed

## Title format

Match the branch's Conventional Commit style: `<type>(<optional-scope>): <subject>`

- Types: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `spike`
- Imperative mood, lowercase subject, no trailing period
- For a single-commit PR, reuse the commit subject
- For a multi-commit PR, write a subject that summarises the whole change

## Description format

Use these sections. Drop a section only when it genuinely does not apply.

```
## What
What this change does, in a few sentence. 

## Why
Why this change is needed, in a few sentences. Explain intent, not a diff. 

## Changes
- Bullet the notable changes a reviewer should look for

## Testing
How it was verified: commands run, tests added, manual checks. State honestly what was and was not tested.

## Notes
Anything else: follow-ups, trade-offs, risks, screenshots. Link issues with `Closes #17` when a github issue was implemented.
```

## Workflow

1. Confirm state: `git status` (clean tree), `git branch --show-current` (not the
   default branch), and `git log <default>..HEAD --oneline` to see the commits
   the PR will contain.
2. Review the diff: `git diff <default>...HEAD` so the title and description
   reflect what actually changed. Never write a PR description blind.
3. Draft the title and description following the formats above.
4. Using the github cli `gh`, create the PR
   for example:

   ```
   gh pr create --base <default-branch> --head <branch> \
     --title "<title>" \
     --body "<description>"
   ```
5. Once the PR exists, report its URL.

## Guardrails

- NEVER add an agent/Claude co-author trailer or attribution to the PR body. Including any session information.
- Base the PR on the default branch unless the user names a different base.
- Dirty tree or unpushed uncertainty: stop and report. Don't stash, reset, or force anything.

## Avoid

- Vague titles: `fix: bug`, `update`, `changes`
- Empty or one-word descriptions that make reviewers reverse-engineer intent
- Bundling unrelated commits into one PR
- Inventing a per-task PR style instead of following the convention
