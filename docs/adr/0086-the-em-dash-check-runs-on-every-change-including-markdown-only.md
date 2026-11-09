# 0086. The em dash check runs on every change, including markdown-only ones

## Status

Accepted

Amends ADR-0043.

## Context

`AGENTS.md` forbids the em dash and code comments, but only instructions and code review enforce that, and both missed the comments in #170. An em dash can be found exactly with a text search. A code comment cannot be found reliably across TypeScript, Nix, shell, OpenTofu and Makefiles, where docstrings are allowed and `#` and `//` also appear in strings and URLs. Em dashes mostly enter through prose, and ADR-0043 runs no check at all on a change that touches only markdown.

- Option 1: A `tests/*.sh` script in `make check-no-vm` only. Markdown-only changes, where most em dashes appear, go unchecked.
- Option 2: The same script, also run as its own job in `ci.yml` on every change, markdown-only included, which the `ci` aggregate requires.
- Option 3: A local check only, such as a git hook. It never blocks a merge, which is how #170 got through.

## Decision

We will go with Option 2. The check fails on an em dash in any tracked text file, except files under a `test/fixtures/` directory, which record real tool output, and the auto-generated `flake.lock` and `package-lock.json`. Vendored skills are checked. Code comments, commit messages and pull request text are not checked mechanically; `AGENTS.md` and `code-review` cover them.

## Consequences

ADR-0043 no longer holds that a markdown-only change gets no check: it gets this one, which takes seconds and needs no Nix build. An em dash in a skill synced from `rameezk/skills` fails the sync pull request until it is fixed upstream. The no-comments rule stays a judgement call for the agent and the reviewer.
