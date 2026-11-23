# 0122. The store is split into concern objects that own their tables

## Status

Accepted

Keeps ADR-0120 as it is.

## Context

`Store` holds every table, migration, row mapper and query for every concern behind 133 mostly one-statement methods, and each concern's writers have one caller module. Concerns still share data in SQL: grade, attempt and verdict reads join `feedback_watches`, urgency reads join `frontier_tickets`, and the workload liveness predicates serve dispatches, revisions, grading and `workloadRunning`.

- Option 1: Concern objects hung off `Store` (`store.grades.recordRiskGrade`), each built by `Store` with an internal connection handle the package never exports. Callers take only the concern object they use.
- Option 2: Free functions taking `Store`, as `auto-merge-selection.ts` does. `Store` must then expose raw SQL for writes, and any module can write any table.
- Option 3: Callers build concerns from an opened connection. The connection is passed around, with Option 2's problem.

For data shared across concerns:

- Option A: A concern owns its tables' schema, migrations, writes and row mapping; others may read them in their own SQL through fragments the owner exports internally, and a write to another concern's table goes through the owner's method in one transaction.
- Option B: No cross-concern reads; joined data is assembled in TypeScript, splitting atomic queries such as `gradingDue` into racing round trips.

## Decision

We will go with Option 1 and Option A. The concerns are `runs`, `frontier`, `workloads`, `grades`, `urgency`, `autoMerge`, `diagnoses` and the table-less `insights`, in `runtime/packages/shared/src/store/`. Each concern migrates its own tables, and `Store` runs them in that order after enabling WAL; every cross-concern migration dependency points to an earlier concern. `Store` keeps only opening, the transaction, the migration order, `dataVersion`, `close` and ADR-0120's narrow `read`. Policy and display text live with their concern.

## Consequences

A change to one concern opens one module, and each caller learns only its concern. Migrations no longer run in their historical interleaved order, which is safe only while every step stays idempotent and probe-gated and no concern's migration depends on a later concern. A new concern that reads another's tables depends on that owner's internal SQL fragments. `store/auto-merge.ts` falls outside ADR-0120's protected `src/auto-merge*.ts` glob, as bookkeeping should. The package keeps explicit re-exports, so a new public type still needs a line in `index.ts`.
