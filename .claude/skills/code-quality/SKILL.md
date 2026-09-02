---
name: code-quality
description: Lint, format, and type-check code to a consistent standard before it is committed or reviewed. Use when the user or agent asks to lint, format, clean up, or check code quality, or after finishing a change and before committing. Enforces a clean, green quality gate.
model: sonnet
---

# Code Quality

## Purpose

Give a consistent, disciplined way to keep the codebase clean - linted, formatted,
and type-checked - so every change lands green, style stays uniform, and quality
problems are caught at the source rather than in review.

## When to use

- The user asks to "lint", "format", "clean up", or "check code quality"
- After finishing a change and before committing or opening a PR
- When a lint, format, or type error surfaces during other work

## Tools

This project uses:

- **ruff** for linting and formatting (`ruff check`, `ruff format`)
- **ty** for type checking (`ty check`)
- **pytest** for tests (see [[tdd]])

Run them through `uv` so the project environment is used:

- Lint: `uv run ruff check .`
- Lint with autofix: `uv run ruff check --fix .`
- Format: `uv run ruff format .`
- Format check only: `uv run ruff format --check .`
- Type check: `uv run ty check`

## Workflow

1. See the current state: run the lint, format check, and type check to know what
   is already failing before you touch anything.
2. Format first: `uv run ruff format .` so style noise does not mask real lint
   findings.
3. Lint: `uv run ruff check --fix .`. Let autofix handle the mechanical fixes,
   then read what remains.
4. Fix the rest by hand: resolve each remaining lint and type finding at its cause.
   Understand why the rule fired; do not silence it to move on.
5. Re-run all three until lint, format, and type check are clean.
6. Report the final result: the commands run and that each is now green.

## Guardrails

- NEVER suppress a finding to force green. No blanket `# noqa`, `# type: ignore`,
  per-file ignores, or rule deletions to make a check pass. Fix the code.
- If a rule genuinely should not apply, suppress it narrowly and inline with a
  reason, and say which rule and why in your report - do not silence broadly.
- Do not weaken the ruff or ty configuration to pass. Config changes are a
  deliberate, separate decision, not a way to clear an error.
- Fix findings at their cause. A type error usually points at a real modelling
  problem; resolve that rather than casting it away.
- Do not reformat or "fix" code unrelated to the current change unless the user
  asks - keep the diff focused. A pre-existing failure you did not cause: fix it or
  report it, but call it out separately.
- Never claim clean without having run the checks and seen them pass.

## Avoid

- Committing with lint, format, or type errors and calling the work done
- Silencing rules instead of fixing the underlying issue
- Running only one check - a clean lint with red types is not clean
- Sweeping unrelated files into the change under the banner of "cleanup"
- Inventing a per-task style instead of letting ruff format decide
