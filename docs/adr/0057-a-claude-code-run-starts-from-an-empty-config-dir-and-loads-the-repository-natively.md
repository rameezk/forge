# 0057. A Claude Code run starts from an empty config dir and loads the repository natively

## Status

Accepted

Amends ADR-0034.

## Context

pi is minimal, so forge supplies its inputs: project instructions, skills and forge's own instructions. Claude Code loads far more by itself: the user's `~/.claude` settings, skills, memory, plugins and hooks, and the repository's `CLAUDE.md` or `AGENTS.md`, `.claude/skills`, `.claude/agents`, settings, hooks and `.mcp.json`. Its docs warn that a session without a previously saved config dir is a "first session" that may miss flag-gated features. A check with Claude Code 2.1.296 found a cold and a warm config dir produce the same init event apart from a per-process socket path, and both read `AGENTS.md`.

- Option 1: Feed a Claude Code run only what pi gets and suppress the rest. Comparable to pi, but it strips the harness of what it is built around.
- Option 2: Load the repository's own Claude Code setup natively, and isolate the run from the host with an empty per-run config dir.
- Option 3: As Option 2, but copy each run's config dir from a seed the runner keeps warm outside the sandbox. Guards against first-session gaps the check did not find.
- Option 4: One shared config dir mounted writable into every run. Any workload could change what later runs load.

## Decision

We will go with Option 2. Each run gets an empty `CLAUDE_CONFIG_DIR` that is discarded after it, and Claude Code reads the repository's instructions, `AGENTS.md` included, and its setup natively. Forge appends its own instructions to Claude Code's system prompt and its subagents' rather than replacing them. The run gets Claude Code's native tools with permission prompts skipped, less any tool that waits on a human, and bwrap stays its security boundary.

## Consequences

A Claude Code run behaves as it would for a developer in that repository, and no host state or earlier run reaches it. The fingerprint covers the repository's Claude Code settings and hooks, which the system prompt and tool hashes do not, and replaces the per-run values in Claude Code's system prompt with placeholders. Claude Code's contract check must repeat the cold and warm comparison on each upgrade, so a version that starts depending on saved state fails there rather than in a run.
