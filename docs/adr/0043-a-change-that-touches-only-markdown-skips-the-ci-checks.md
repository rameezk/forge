# 0043. A change that touches only markdown skips the CI checks

## Status

Accepted

## Context

ADR-0036 and ADR-0042 run the full check suite, including the NixOS VM tests, behind the required `ci` status check on every change. That run takes about 10 minutes, and it runs even for changes such as ADRs, `docs/CONTEXT.md` or skills, which no check reads. The `main` ruleset requires the `ci` status check, so if the workflow does not trigger, `ci` never reports and the PR cannot merge. Not everything under `docs/` is inert: `docs/assets/logo.svg` is built into the runner and tested.

- Option 1: Add `paths-ignore` to the workflow. It is simple, but `ci` never reports on a skipped PR, so the PR is blocked.
- Option 2: Add a second workflow with matching `paths` and a stub job also named `ci`. This keeps the required check reporting, but two checks with the same name are fragile and confusing.
- Option 3: Add a first job that uses `dorny/paths-filter` to decide whether to run the checks. This works, but it adds a third-party action with access to the workflow just to replace a one-line diff.
- Option 4: Add a first job that runs `git diff --name-only` against the base and reports whether any file other than `*.md` changed. The check jobs run only when one did. The `ci` aggregate always runs and passes when the check jobs were skipped for a markdown-only change.
- Option 5: Like Option 4, but match a list of directories instead of the `*.md` file type. This needs maintaining as the repository changes, and is easy to get wrong for `docs/assets/`.

## Decision

We will go with Option 4. A change skips the checks only when every file it changes ends in `.md`. Any other changed file means the full run. The same rule applies to pull requests, diffed against their base, and to pushes to `main`, diffed from `before` to `after`. When the base cannot be determined, such as for a new branch or a force push, the full run happens. Markdown-only changes get no replacement check.

## Consequences

Markdown-only changes merge without waiting about 10 minutes for checks. The VM-test gate from ADR-0036 and ADR-0042 now covers every change that touches a file other than markdown, rather than every change. A markdown file that later becomes an input to a build or a test would skip the checks that cover it, so making markdown load-bearing means revisiting this rule. A markdown-only merge to `main` pushes nothing to cachix.
