# 0074. Claude Code runs never add attribution

## Status

Accepted

## Context

The runner starts `claude` with an empty `CLAUDE_CONFIG_DIR` and its own settings, so Claude Code's default attribution is on. Its system prompt then tells the model to end pull request bodies with a "Generated with Claude Code" line and commits with a `Co-Authored-By` trailer. That contradicts the repository's AGENTS.md and the skills' guardrails, and the model sometimes follows the harness: pull requests #476 and #480 opened with the line.

- Option 1: The runner always sets Claude Code's `attribution.commit` and `attribution.pr` to empty for every run.
- Option 2: An operator option on the claude-code harness, defaulting to on. It adds a setting to choose something forge never wants, and leaves the conflict in place by default.
- Option 3: Rely on the written rules in AGENTS.md and the skills. They lose to the harness's own system prompt often enough to leak.

## Decision

We will go with Option 1. Forge's work is already authored by the operator's GitHub App bot, and pi never adds attribution, so turning it off keeps both harnesses the same with no extra setting. The claude-code CLI contract check fails if the system prompt the CLI sends still carries the attribution instruction.

## Consequences

Claude Code runs no longer get conflicting instructions about attribution. A CLI update that renames or drops the `attribution` setting fails CI instead of reaching pull requests. The written rules in AGENTS.md and the skills stay, because they still cover pi, issues, comments and repositories run elsewhere.
