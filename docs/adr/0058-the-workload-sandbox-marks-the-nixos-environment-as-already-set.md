# 0058. The workload sandbox marks the NixOS environment as already set

## Status

Accepted

## Context

The sandbox binds the host's `/etc` read-only but not `/run`. A login shell inside it sources NixOS's `/etc/profile`, which loads `set-environment` and replaces `PATH`, `LOCALE_ARCHIVE`, `TZDIR`, `LANG`, `NIX_PATH` and `TERM` with values pointing at `/run/current-system`, so every tool on the runner's curated `PATH` disappears. Claude Code 2.1.296 builds its shell snapshot with `bash -c -l`, and once the snapshot fails it runs every Bash command as a login shell, so every claude-code run so far lost `gh`, `git` and coreutils.

- Option 1: Set `__NIXOS_SET_ENVIRONMENT_DONE=1` for every sandboxed process. `/etc/profile` and `/etc/bashrc` skip `set-environment` when it is set, which is what NixOS itself uses it for. Depends on a NixOS-internal variable name.
- Option 2: Bind an empty file over `/etc/profile` and `/etc/bashrc` in the sandbox. Independent of the variable name, but drops all system login config and has to bind over `/etc/static` symlinks.
- Option 3: Bind an allowlist of `/etc` entries instead of all of it. Tighter isolation, but a much larger change with a wide blast radius.
- Option 4: Restore `PATH` for Claude Code alone through `CLAUDE_ENV_FILE`. Leaves the other overwritten variables broken and leaves other harnesses exposed.

## Decision

We will go with Option 1. The sandbox sets `__NIXOS_SET_ENVIRONMENT_DONE=1` in the environment of every process it spawns, so the environment the runner deliberately built survives a login shell for any harness or tool.

## Consequences

Login and non-login shells in a workload see the same environment, and Claude Code's shell snapshot succeeds. Forge now relies on the name of a NixOS-internal guard variable; the workload sandbox VM test probes a login shell so a NixOS release that renames it fails there rather than in a run.
