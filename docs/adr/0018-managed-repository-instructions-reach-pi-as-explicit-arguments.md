# 0018. Managed repository instructions reach pi as explicit arguments from a fresh checkout

## Status

Accepted

Refines ADR-0015.

## Context

A dispatched workload runs a managed repository's own skills and `AGENTS.md`/`CLAUDE.md`, but ADR-0015 turns off everything pi discovers by itself. pi 0.75.4 walks context files from the cwd up to `/` with no way to scope the walk, silently ignores a missing `--skill` path, silently treats a missing `--append-system-prompt` path as literal text, and passes an unknown `/skill:<name>` prompt through unchanged. A checkout reused across runs is itself state a run can write.

- Option 1: A persistent mirror per repository with a worktree per workload, and pi's own discovery turned back on under directories the runner cannot write. Cheaper fetches, but the mirror is shared state a run can write through `.git`, and safety rests on filesystem permissions staying right.
- Option 2: A mount namespace per workload whose parent directories are empty. Scopes pi's discovery exactly, at the cost of namespace machinery for a handful of files.
- Option 3: A fresh clone per workload, with `--no-context-files` and `--no-skills` kept on, and the runner passing what the checkout root holds as explicit arguments.

## Decision

We will go with Option 3.

- Each workload gets a fresh blobless clone of the default branch as its run directory and cwd.
- The runner passes each of `.claude/skills`, `.agents/skills` and `.pi/skills` at the checkout root that exists as `--skill <path>`.
- It passes the root `AGENTS.md`, or `CLAUDE.md` if there is none, as `--append-system-prompt` values that reproduce pi's `<project_instructions>` wrapper. Nested context files are not loaded.
- It passes the root `.pi/SYSTEM.md` as `--system-prompt` and `.pi/APPEND_SYSTEM.md` as another `--append-system-prompt`.
- It appends a fixed instruction that no human will answer: proceed on what the ticket or its spec settles, and otherwise stop and end with the question.
- All of these go into the contract argv, so every subagent gets the same arguments.
- A worker prompt that starts with `/<name>` is rewritten to pi's `/skill:<name>` once the runner has found that skill in the checkout. If the skill is missing, the dispatch fails before pi starts.

## Consequences

Nothing a run writes reaches a later run, because every run starts from a fresh clone. The runner checks every path before passing it, so none of pi's silent fallbacks can fire. Worker prompts stay harness-neutral (`/work-on {url}`), and each harness adapter maps them to its own syntax. Every run pays for a clone. A repository's nested `AGENTS.md` files are ignored.
