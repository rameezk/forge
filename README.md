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
