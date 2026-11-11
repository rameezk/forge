# 0102. A failed workload is diagnosed by a workload of the diagnosis worker

## Status

Accepted

## Context

A failed dispatch, revision or conflict resolution records what went wrong as a mechanical reason such as `check-failed` or `no-pull-request`, but not why. Finding the cause means reading the transcript by hand, which is where feeding failures back into better workers stalls.

- Option 1: Cascade a failed dispatch to a stronger worker, or have an agent write the orchestration plan. Neither answers a problem forge has seen, and an agent-written plan moves runtime policy out of declared config.
- Option 2: A direct model call from the runner over the failed run. Not sandboxed, costed or fingerprinted like a run, so diagnoses cannot be trusted or compared.
- Option 3: A workload of an operator-declared diagnosis worker, started automatically after each failure that does not explain itself, and re-run on demand with `forge-diagnose`.
- Option 4: As Option 3, but on demand only, or automatic only.

## Decision

We will go with Option 3. A global `forge.runtime.diagnosis.worker` names the worker. Its workload runs in the workload sandbox with the failed run's transcript, request record, failure reason and ticket context, treats all of it as untrusted, and gets read-only GitHub access and no write token. It reports one cause category - worker, skill, ticket or spec, repository environment, forge, provider and infrastructure, or unclear - with evidence pointing at transcript turns and one suggested fix. Diagnoses are shown on the failed run's page and grouped by category and cohort on the dashboard, and never posted to GitHub, as ADR-0077 requires.

## Consequences

Every failure in scope costs one more workload, budgeted by the diagnosis worker. Diagnoses are recorded and fingerprinted like any run, so each diagnosis worker forms cohorts of its own, though diagnoses never appear in the Insights tables. The diagnosis gets a read-only token minted from forge's GitHub App, as forge already mints for its own reads, never the workload write token. Acting on a diagnosis stays with the operator; forge files no issues and changes no config from it.
