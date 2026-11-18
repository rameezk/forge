# 0116. A dedicated reviewer App in its own service approves and merges auto-merges

## Status

Accepted

Builds on ADR-0115 and keeps ADR-0105.

## Context

ADR-0105 requires an approving review after the last push on every managed repository, with no bypass for forge's App. Forge's App authors and pushes every forge pull request, so it cannot give that approval, and auto-merge (ADR-0115) needs a second identity. That identity must stay out of reach of a leaked workload token, and must not live where untrusted diffs are processed. GitHub does not document whether an App's approval counts toward a ruleset's required approvals. Community reports say it does.

- Option 1: A new reviewer App whose key only a `forge-auto-merge` service of its own holds. That service checks every gate on the current head, then approves and merges at that head's commit.
- Option 2: The same App, held by the grading service, which reads adversarial diffs and calls OpenRouter.
- Option 3: Reuse the box App (ADR-0109), mixing managed-repository approval with the box's deploy.
- Option 4: A machine-user account with a personal access token, which ADR-0049 moved away from.
- Option 5: Give the reviewer App a bypass of the pull request rule instead of an approval.

## Decision

We will go with Option 1. Before anything depends on it, we prove on a sample pull request that the App's approval satisfies the rules. If it does not, we fall back to Option 4. Option 5 is never used, because a bypass skips the whole rule rather than satisfying it. The ADR-0105 check also verifies that the reviewer App is installed and has no bypass.

## Consequences

A leaked workload token cannot approve, and pushing after an approval voids it. A leaked reviewer key alone cannot get a change in front of itself, so landing code takes two compromises. Every operator creates and installs a third App. Forge gains a service, and the grading service never holds an approving key.
