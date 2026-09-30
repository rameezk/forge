# 0015. pi loads nothing from state a run can write

## Status

Accepted

## Context

pi 0.75.4 loads code and instructions at startup from places the runner user can write. Its agent dir defaults to `~/.pi/agent`, and the runner's HOME is `/var/lib/forge`. That dir can hold extensions, skills, prompt templates, `settings.json` (which can list packages, add paths, and set `shellCommandPrefix` and `npmCommand`), `models.json` (where values starting with `!` run as shell commands), `SYSTEM.md` and `APPEND_SYSTEM.md`. pi also reads `AGENTS.md`/`CLAUDE.md` in every directory from the cwd up to `/`, which includes `/var/lib/forge/work` and `/var/lib/forge`. A prompt-injected run could plant any of these, and every later run of every worker would load them with `OPENROUTER_API_KEY` in its environment. Subagents build their argv from the adapter's fixed contract flags, not from operator extras, and they inherit the parent's environment (ADR-0009).

- Option 1: Operators add `--no-*` flags through `harness.args`. These never reach subagents, and each operator has to remember them.
- Option 2: Add `--no-*` flags to the adapter's fixed argv. This does not cover the agent dir's `settings.json`, `models.json` or `SYSTEM.md`.
- Option 3: Point `PI_CODING_AGENT_DIR` at a fresh writable directory for each run. This separates runs, but the run can still write to it while it is running, and each directory has to be cleaned up.
- Option 4: Option 2, plus `PI_CODING_AGENT_DIR` set to an empty, read-only nix store path.

## Decision

We will go with Option 4. The adapter's fixed contract flags gain `--no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files`, which extends ADR-0008's argv, so subagents inherit them. Explicit `-e <nix store path>` still loads, so the subagent extension is unaffected. The `forge-run` wrapper supplies an empty store path, and the adapter sets `PI_CODING_AGENT_DIR` to it. pi runs with that dir read-only because `--no-session` is already a fixed contract flag. The guarantee is that nothing a run writes changes what pi loads at startup in a later run. One gap stays accepted: a subagent still reads its cwd's `.pi/settings.json` and `.pi/SYSTEM.md`, which the parent run could write, but that run already has bash.

Managed repositories bring their own skills and context files, and loading them is a hard requirement on the slice that checks managed repositories out (#106). The checkout slice passes `.claude/skills`, `.agents/skills` and `.pi/skills` at the checkout root as explicit `--skill <path>` arguments to the parent and every subagent. It honours `AGENTS.md`/`CLAUDE.md` from the checkout root only.

## Consequences

A compromised run cannot leave behind anything pi loads in later runs. Operators can still add skills or extensions on purpose through `harness.args`. pi's context-file discovery cannot be scoped from the command line, so `--no-context-files` stays on. The checkout slice has to feed a repository's `AGENTS.md` in another way, for example `--append-system-prompt` or a mount namespace whose parent directories are empty. This ADR does not touch the runner's wider reach into `/var/lib/forge`: a writable HOME for other tools' dotfiles, writable `forge.db` and `transcripts/`, and a readable `github.env`. That is #107.
