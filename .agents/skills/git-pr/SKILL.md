---
name: git-pr
description: Prepare and open a GitHub pull request cleanly and consistently. Use when the user or agent asks to open a PR or raise a pull request. Enforces a PR title and description convention.
---

# Git PR

## When to use

- The user asks to "open a PR" or "raise a pull request"
- A branch has one or more committed changes ready to be reviewed

Assumes commits are already made via [[git-committing]] and the branch
follows [[git-branching]]'s naming convention.

## Title format

Match the branch's Conventional Commit style: `<type>(<optional-scope>): <subject>`

- Types: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `spike`
- Imperative mood, lowercase subject, no trailing period
- For a single-commit PR, reuse the commit subject
- For a multi-commit PR, write a subject that summarises the whole change

## Description format

Use these sections. Drop a section only when it genuinely does not apply.

```markdown
## What
What this change does, in a few sentences. 

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
4. Push the branch: `git push -u origin <branch>` (skip only if it is already
   pushed and up to date). `gh` needs the branch on the remote.
5. Using the github cli `gh`, create the PR
   for example:

   ```bash
   gh pr create --base <default-branch> \
     --title "<title>" \
     --body "<description>"
   ```
6. Once the PR exists, report its URL.

## Guardrails

- NEVER add an agent co-author trailer, attribution, generated-by credit, or
  session link to the PR title or body.
- Base the PR on the default branch unless the user names a different base.
- Assumes `gh` is authenticated. If `gh auth status` fails, stop and ask the
  user to run `gh auth login`.
- Dirty tree or unpushed uncertainty: stop and report. Don't stash, reset, or force anything.

## Avoid

- Vague titles: `fix: bug`, `update`, `changes`
- Empty or one-word descriptions that make reviewers reverse-engineer intent
- Bundling unrelated commits into one PR
