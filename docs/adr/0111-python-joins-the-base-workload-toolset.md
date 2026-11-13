# 0111. Python joins the base workload toolset

## Status

Accepted

Builds on ADR-0027.

## Context

Agents edit code through `python3` heredocs far more than through any other tool. Across the box's 286 runs, 204 did so, about 1,276 calls. Python reached forge's own runs only because `nixos-rebuild-ng` in forge's devShell carries it. Elsewhere it is missing: 73 runs hit `python3: command not found`, including 18 of 20 on rebind, 16 of 18 on unmasked and 13 of 14 on patient-folio. Each miss costs a turn and a fallback to `sed`, `perl` or `node -e`, which edit multi-line text less reliably.

- Option 1: Add `pkgs.python3`, standard library only, to the base toolset.
- Option 2: Leave Python to each repository's devShell. Every repository must add a tool it does not use itself.
- Option 3: Tell agents to use their harness's native edit tool. Claude Code has one and still picks Python.
- Option 4: Add `python3Minimal`. It is smaller but drops `ssl`, `sqlite3` and `readline`.
- Option 5: Add Python with packages such as `pyyaml`. Those are a repository's concerns and drift.

## Decision

We will go with Option 1. Python here is a generic editing tool, like `jq`, `sed` and `gawk`, not a repository's stack, so ADR-0027 still holds. The toolset stays after the devShell, so a repository's own Python wins. `node` does not join: only 31 runs used it inline, mostly where the devShell already had it.

## Consequences

Every workload can edit with Python, whatever its repository ships. The box's store carries Python's closure. If transcripts start showing `node: command not found`, Node's place in the toolset is a new decision.
