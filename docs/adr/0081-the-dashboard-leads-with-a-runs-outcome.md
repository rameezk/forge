# 0081. The dashboard leads with a run's outcome

## Status

Accepted

## Context

ADR-0071 shows a run's status and its workload's outcome as two identical pills side by side wherever the run's status appears. Read at a glance, `success` beside `error` looks contradictory, nothing says which pill is which, and nothing says whether the run was a dispatch, a revision or a conflict resolution.

- Option 1: Keep both pills and label them.
- Option 2: Lead with the outcome alone, and show the run's status beside it only when it is not `success`.
- Option 3: Fold the outcome into the run's status, as ADR-0071 rejected.

## Decision

We will go with Option 2. Wherever a run appears, on the workloads list and its cards, the run page and the attempts page:

- The outcome is the one pill, `running`, `done` or `failed` (ADR-0080).
- The run's status shows beside it only when it is `harness error`, `interrupted` or `exceeded`; the reason line names the limit an exceeded run crossed.
- A run with no dispatch, revision or conflict resolution shows its run status alone.
- Each pill carries a tooltip saying what it means.
- The kind of workload, `dispatch`, `revision` or `conflict resolution`, is labelled under its ticket or pull request.
- The status filter is by outcome, `running`, `done` or `failed`; a run with no outcome counts as `done` when it succeeded, `failed` when it ended any other way, and `running` while it runs.

## Consequences

A `success` never sits beside a failed outcome, so the operator reads the outcome first, and a stopped or errored harness still shows. A clean run's status is visible only on hover or the run page's details. The mobile-only `revision` pill gives way to the kind label.
