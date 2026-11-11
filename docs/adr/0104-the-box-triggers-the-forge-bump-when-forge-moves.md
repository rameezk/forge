# 0104. The box triggers the forge bump when forge moves

## Status

Accepted

## Context

ADR-0090 bumps the operator repository's `forge` input from a GitHub Actions job scheduled hourly. GitHub runs scheduled workflows best effort: over one 17-hour window the hourly `forge-bump` ran three times, none on schedule, so a forge change took hours to reach the box. We want a forge change running on the box within about ten minutes, for every operator.

- Option 1: forge's CI sends `repository_dispatch` to each operator repository when `main` moves. forge would have to know every operator repository and hold a write credential for each, which a generic public library cannot.
- Option 2: The box, which already polls its operator repository, also watches the forge input's upstream with `git ls-remote` and calls `workflow_dispatch` on the operator repository's `forge-bump` when it moves. CI still bumps, runs the divergence guard and commits. The box's App token gains `actions: write` on the operator repository.
- Option 3: An external scheduler calls `workflow_dispatch` every few minutes. Another third-party service and credential for every operator, still polling blindly.
- Option 4: Schedule the job more often. Still best effort, and GitHub drops more runs under load.

## Decision

We will go with Option 2, shipped by forge for every operator. The pull deploy checks the forge upstream and the operator repository's `main` every 60 seconds, down from 300. It dispatches once for each new upstream rev that differs from the rev locked on `main`, and again only if the dispatch call itself failed; a rev the divergence guard rejects is not retried until forge moves or the operator runs the job by hand. Dispatch errors are recorded in the pull deploy's status file and journal. `forge-bump` loses its schedule and keeps only `workflow_dispatch`: a box that is down has nothing to deploy, and a failed dispatch is retried at the next poll. The bump does not wait for forge's own CI on `main`. This supersedes ADR-0090; its GitOps pull, commit-per-bump audit trail and template handling stand.

## Consequences

A forge change reaches the box in about a minute of detection, a minute or two of CI and a minute of polling, plus the build. The box can now start workflows in its operator repository, though it still cannot write to it. Operators without the pull deploy get no automatic bumps and upgrade by hand with `upgrade-forge`. A bump can land on a forge commit whose `main` CI has not finished, relying on the required pull request checks and the divergence guard.
