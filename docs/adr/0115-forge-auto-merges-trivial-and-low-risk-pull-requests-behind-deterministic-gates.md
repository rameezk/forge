# 0115. Forge auto-merges trivial and low risk pull requests behind deterministic gates

## Status

Accepted

Builds on ADR-0103 and keeps ADR-0105.

## Context

Review limits throughput (ADR-0092), and ADR-0103's risk grades were built so trivial and low risk pull requests could merge without a person. On the operator's box, 84 heads were graded from 12 to 18 November 2026. All 19 settled trivial and low grades merged as graded, and the three counted against a grade were forge pushing a merge of `main`. No graded head at any level was closed or superseded by a revision, so the data shows forge's pull requests are sound. It cannot show that Jev catches an unsound one. Jev reads the diff, so a prompt-injected workload can write a diff meant to grade trivial. ADR-0105 requires an approving review after the last push, with no bypass for the App.

- Option 1: Keep every merge manual.
- Option 2: Shadow first. Forge records which pull requests it would have merged and a person keeps merging, until the record justifies going live.
- Option 3: Go live, merging on the grade alone.
- Option 4: Go live, with checks that do not depend on the model alongside the grade, an approver the workload never holds, a maintainer veto, a self-pause when grades stop holding up, and a human-reviewed sample.

## Decision

We will go with Option 4. A pull request auto-merges only if it is graded trivial or low with a certain grade on its current head, is settled, has every required check green and no open feedback, touches no protected path, stays under a size cap, and has every changed file's content in Jev's input. It also needs a repository that opted in. The approval comes from an identity that no workload holds, and ADR-0105's rules stay as they are. Shadow mode was rejected because it would only add more of the evidence already in hand: pull requests a person merges unchanged.

## Consequences

Trivial and low risk pull requests stop waiting for review. The gates that do not depend on the model bound what an adversarial diff can land, whatever Jev says. Auto-merged pull requests give no outcome of their own, so the record of how grades hold up relies on the human-reviewed sample. Forge's own merges of the default branch must stop counting against a grade. The approver's identity, the veto, the pause rule and the sample are separate decisions.
