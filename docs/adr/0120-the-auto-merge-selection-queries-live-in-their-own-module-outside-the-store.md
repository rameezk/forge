# 0120. The auto-merge selection queries live in their own module outside the store

## Status

Accepted

Builds on ADR-0115.

## Context

The store queries that select what auto-merges live in `store.ts`, which most dashboard and insights work touches. They are candidate selection, the pause and warm-up status, and the sample draw. An operator who adds `store.ts` to `protectedPaths` blocks most routine pull requests from auto-merging, and one who does not lets an auto-merged pull request change what auto-merges.

- Option 1: Move only the candidate query into its own module. The pause and sample queries, which also decide what auto-merges, stay open to change.
- Option 2: Move every store query whose result decides whether a pull request auto-merges into one module that callers use directly, with `Store` keeping no delegating method for them.
- Option 3: Protect `store.ts`. Most routine pull requests stop auto-merging.

## Decision

We will go with Option 2. `autoMergeCandidates`, `autoMergeStatus`, `drawSample` and `pullRequestSampled` move to `runtime/packages/shared/src/auto-merge-selection.ts`. Its functions take the `Store` and run their SQL through one narrow read method on it. No selection method remains on `Store`, so a change to `store.ts` cannot point a caller at different rules. Auto-merge bookkeeping and dashboard counts stay in `store.ts`. The forge operator protects `runtime/packages/shared/src/auto-merge*.ts`, and that glob also covers the pause and sample thresholds in `auto-merge-status.ts`.

## Consequences

An operator can protect every rule that selects what auto-merges without protecting the store. The plumbing those rules rely on stays unprotected in `store.ts`: `workloadRunning`, the risk grade row mapping, the `risk_grades` and `feedback_watches` schema and its migrations, and the read method itself. An auto-merged change there can still weaken the selection indirectly. This is accepted because protecting that plumbing would bring back the problem of protecting the whole store.
