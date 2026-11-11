# 0090. An operator's box follows its operator repository's main, and CI bumps forge hourly

## Status

Superseded by ADR-0104

## Context

Operators upgrade forge by hand every day or two with the `upgrade-forge` skill: bump the `forge` input, merge template changes, commit, push and `just deploy` from their workstation. We want this to happen hourly without a person, with a git commit as the audit trail.

- Option 1: GitOps pull. A scheduled GitHub Actions job in the operator repository bumps the `forge` input and commits to `main`; a timer on the box pulls `main` and switches to it. CI holds no access to the box, and the box holds only read access to the operator repository.
- Option 2: CI push. The scheduled job bumps, commits, joins the tailnet and deploys. CI holds an admin SSH key with sudo on the box and a tailnet credential.
- Option 3: The box bumps, switches and pushes the commit back itself. The box, where workloads run, holds a write credential for the operator repository.
- Option 4: A scheduled agent runs the `upgrade-forge` skill. Nondeterministic, paid every hour, and needs the operator's age key and admin SSH unattended.

## Decision

We will go with Option 1, shipped by forge for every operator: the box side as a forge NixOS option and the CI side in the operator template. The job only bumps the `forge` input, one commit per actual bump with the upstream commit subjects in its body, and nothing when forge has not moved. Template drift and newly required secrets are detected and surfaced to the operator, never merged automatically. The operator repository's `main` is what the box runs.

## Consequences

Every forge version the box runs is a commit on `main`. A hand deploy of unpushed changes with `just deploy` is reverted at the next pull, so `just deploy` becomes a way to try a change before pushing it. Template files still reach the operator only through a person or the `upgrade-forge` skill. Deploys stay safe for running workloads through ADR-0035.
