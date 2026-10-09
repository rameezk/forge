# 0053. A symlink to markdown counts as a markdown-only change

## Status

Accepted

## Context

ADR-0043 skips the CI checks only when every changed file ends in `.md`. Adding or removing a skill also adds or removes a symlink under `.claude/skills/` that points to a directory of markdown under `.agents/skills/`. The symlink has no `.md` extension, so a change that touches only skills runs the full suite, as in #310.

- Option 1: Treat any change under `.claude/skills/` as markdown-only. It is true today, since no check reads that directory, but it is the directory list ADR-0043 rejected as Option 5.
- Option 2: Treat a changed symlink as markdown-only when it points to a `.md` file or to a directory whose files, at any depth, all end in `.md`. This keeps ADR-0043's rule about file types.
- Option 3: Treat any changed symlink as markdown-only. A symlink can redirect a build input, for example into `nix/`, so this is too loose.

## Decision

We will go with Option 2, for symlinks anywhere in the repository. A changed path is checked on each side of the diff where it exists, with a symlink's target resolved in that same side's tree, and it counts as markdown-only only if every side passes. On a side where it is a regular file, it must end in `.md`. A symlink that dangles, points outside the repository, or points to another symlink means the full run.

## Consequences

Adding, removing or retargeting a symlink to a markdown-only skill no longer runs the checks. A symlink to a skill that holds anything other than markdown, such as a script, still means the full run. The rule now reads tree contents rather than just changed paths, so `scripts/markdown-only.sh` has to inspect git trees at both the base and the head.
