# 0080. A workload has one outcome vocabulary

## Status

Accepted

## Context

A dispatch's outcome is `running`, `done` or `failed`, with `interrupted` and `exceeded` as reasons. A revision's and a conflict resolution's is `running`, `ok`, `error`, `exceeded` or `interrupted`. The dashboard showed both vocabularies side by side, so `done` and `ok` read as different things, and a stopped revision repeated its run's status as its outcome.

- Option 1: Map the words to one vocabulary on the dashboard only, and keep the stored states.
- Option 2: Rename the revision and conflict resolution states to the dispatch's, `running`, `done` or `failed`, with `interrupted` and `exceeded` as reasons, and migrate the stored rows.

## Decision

We will go with Option 2. Every outcome is `running`, `done` or `failed`. Whether the work landed lives in the outcome, and why the harness stopped lives in the run's status and the outcome's reason.

## Consequences

The store migrates existing revision and conflict resolution rows. Filters, tests and pages share one set of outcome words, and no display mapping has to be kept in step with the stored states.
