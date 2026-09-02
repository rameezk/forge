# forge

A software factory: tools that turn GitHub triage tickets into reviewed
implementation plans.

## Triage watcher

`forge-watch` does one pass over the open GitHub issues labelled `forge:triage`
in the current repository: for each issue it comments that a blueprint is
running, then runs a headless planning agent - driven by the `blueprint`
skill's copied methodology and template - over the ticket, opens a new issue
whose title is the plan's own heading and whose body is the plan (with a
`Planned from #<number>` reference back to the triage ticket) labelled
`forge:ready`, then closes the original `forge:triage` issue. Closing is the
last step, so any earlier failure leaves the triage issue open for the next
pass to retry.

Cadence is delegated to an external scheduler - point cron or launchd at the
script to get a recurring watch.

### Prerequisites

- The GitHub CLI (`gh`) installed and authenticated (`gh auth status`).
- The `forge:ready` label must already exist in the target repository, or every
  issue creation fails. Create it once:

  ```sh
  gh label create forge:ready
  ```

### Running

Run from within the checkout the plans should investigate:

```sh
forge-watch
```

or equivalently:

```sh
python -m forge.watch
```

The command logs its progress to stderr (start, issue count, per-issue
progress, and a final summary) and exits non-zero if any issue failed. Raw
`gh` CLI error output is only logged at `DEBUG`; stdout stays empty.

## Forge builder

`forge-build` does one pass over the open GitHub issues labelled `forge:ready`
in the current repository, picks the single oldest one, and hands it to a
headless implementation agent - driven by the `forge` and `git-pr` skills'
copied methodology - that implements the plan, runs the project's build/lint/
tests, commits, pushes a feature branch, and opens a pull request with
`gh pr create`. Unlike the triage watcher, it processes at most one issue per
run and never retries automatically.

Each run is capped at 4 USD (`max_budget_usd`); a run that exceeds it fails
cleanly rather than running away.

The issue moves through this label lifecycle:

- `forge:ready` -> `forge:building` when the run claims the issue
- `forge:building` -> `forge:done`, with a comment linking the opened PR, on
  success
- `forge:building` -> `forge:failed`, with a comment containing the failure
  reason, if the run cannot deliver a PR

A `forge:failed` issue is not retried automatically - a build failure usually
needs a human, and each attempt can cost up to 4 USD.

### Prerequisites

- The GitHub CLI (`gh`) installed and authenticated (`gh auth status`).
- The `forge:building`, `forge:done`, and `forge:failed` labels must already
  exist in the target repository, or relabelling fails. Create them once:

  ```sh
  gh label create forge:building
  gh label create forge:done
  gh label create forge:failed
  ```

### Running

Run from within the checkout the issue should be implemented against:

```sh
forge-build
```

The command logs its progress to stderr (the picked-up issue and its cost) and
exits non-zero if the run failed. Raw `gh` CLI error output is only logged at
`DEBUG`; stdout stays empty.

## Security notes

The watcher feeds fully attacker-controllable issue text (title and body) into
the `blueprint` agent, which runs with filesystem read access to the working
directory, and publishes the agent's raw output as a new public issue (its title
and body) with no human review. A crafted issue can therefore attempt prompt
injection to read local files (secrets, private source) and have them echoed into
the newly created public issue.

Mitigations to apply before running this against sensitive checkouts or with
open label-application permissions:

- Restrict who can apply the `forge:triage` label - the whole trust boundary
  rests on that label only being applied to vetted issues.
- Run the watcher against a checkout that does not contain secrets, or point its
  working directory away from secret material.
- Add a human-in-the-loop review of the generated plan before the new issue is
  opened, if the target issues are public.

The `forge-build` agent runs with `bypassPermissions` and can edit files, run
arbitrary commands, push branches, and open pull requests, driven by
attacker-influenced issue text. Its entire trust boundary is the `forge:ready`
label: apply it only to issues produced by the vetted `blueprint` flow (or
otherwise fully reviewed by a human), and run it only against a checkout that
holds no secrets. `block-main-push.sh` still blocks a direct push to
`main`/`master`, but the agent can still open a PR from attacker-influenced
content.
