# 0039. pi never trusts the checkout's project config

## Status

Accepted

Amends ADR-0015.

## Context

pi 1.0.0 adds project trust. Without `--approve` or `--no-approve`, a checkout holding `.pi/skills`, `.pi/SYSTEM.md` or `.agents/skills` makes pi lock `trust.json` in its agent dir, which fails on an agent dir the workload cannot write (ADR-0015, ADR-0033). With either flag, the skills, system prompt and project instructions forge passes as explicit arguments still reach the provider. ADR-0015 accepted that a subagent reads its cwd's `.pi/settings.json`, which the parent run could write.

- Option 1: Pass `--approve`. pi trusts the checkout and keeps loading its project config, so ADR-0015's gap stays open.
- Option 2: Pass `--no-approve`. pi ignores the checkout's project config, so a repository that ships pi config for its own developers silently loses it under forge.
- Option 3: Option 2, plus the runner warns about the project config pi ignores.

## Decision

We will go with Option 3. `--no-approve` joins the adapter's fixed contract flags, so subagents inherit it. Before the workload starts, the runner looks in the checkout for the files pi loads only for a trusted project and prints a warning in the run output naming each one it found. The run proceeds.

## Consequences

pi never writes trust state, and ADR-0015's accepted `.pi/settings.json` gap is closed. A repository's skills, system prompt and `AGENTS.md` still reach pi only through forge's explicit arguments. A repository's other pi config never applies under forge, and the warning is the only sign of it. If that proves too easy to miss, a structured flag on the run page is the follow-up. Failing the run was rejected, because a repository may keep pi config for its human developers.
