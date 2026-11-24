# 0123. Forge does not stack pull requests

## Status

Accepted

## Context

GitHub's native stacked pull requests went generally available on 2026-10-06. Each pull request in a stack targets the branch below it, checks and reviews are enforced against the stack's base, merges go bottom-up and merging one lands every unmerged pull request below it, GitHub rebases the rest of the stack after a partial merge, and the legacy merge endpoints cannot merge a stack. Auto-merge for stacks was announced but not confirmed shipped.

Forge dispatches a ticket only once every blocker is closed, so its work always branches off the default branch. Stacking would let a blocked ticket start on its blocker's open pull request. Across forge, rebind.koplugin, patient-folio, jarvis and unmasked up to 2026-11-23, 236 blocked tickets waited a median 0.2 to 1.0 hours per repository for their last blocker's pull request to merge. 44 waited 3 to 20 hours, all behind 22 pull requests a human reviewed and merged, mostly overnight, and 5 of those had changes requested. The median from a blocker merging to the blocked ticket's pull request opening was 1.5 hours, which bounds what stacking could save on that tail, since the upper pull request still merges only after its blocker.

- Option 1: Stack in forge and the repository skills. A blocked ticket dispatches onto its blocker's open pull request. The frontier, auto-merge and the reviewer app's merge path, the revision and conflict resolution workloads, and the merge-not-rebase rule with its reviewed SHAs all change, for about 1.5 hours saved on one blocked ticket in five.
- Option 2: Stack only in the repository skills. Forge still dispatches off the default branch, so almost nothing is gained.
- Option 3: Do not stack. A blocker merges before the ticket it blocks starts.

## Decision

We will go with Option 3. The frontier keeps requiring every blocker closed, and forge and its skills branch every ticket off the default branch.

## Consequences

Each pull request still lands on its own, so auto-merge decisions stay per pull request and no history is rewritten under a review. A ticket blocked by a human-reviewed pull request keeps waiting for that review, often overnight. Revisit when human-reviewed blockers hold up a significant share of blocked tickets and auto-merge for stacks is confirmed generally available; adopting stacks then is a new decision.
