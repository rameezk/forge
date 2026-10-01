# 0017. One GitHub write token, shared by forge and the dispatched agent

## Status

Accepted

## Context

Dispatch writes to GitHub. Forge swaps a ticket's `forge:*` labels (ADR-0016), and a managed repository's skills push branches, open pull requests, comment and relabel while the agent runs. The box holds only the frontier's read-only token (ADR-0010). Any credential in a run's environment is reachable by a prompt-injected run, the exposure ADR-0015 guards against.

- Option 1: One fine-grained token, scoped to the managed repositories with Contents, Pull requests and Issues write. Forge uses it for the label lifecycle and the agent gets it in its environment, so repository skills work unchanged.
- Option 2: Only forge holds a token. Forge pushes and opens the pull request after the run, and the agent has no credential. Skills that write to GitHub mid-run stop working and need a forge-specific contract.
- Option 3: Two tokens, forge's with Issues write and the agent's with Contents, Pull requests and Issues. Both can relabel issues, so a run can still fake a lifecycle change, and operators place a second secret by hand.

## Decision

We will go with Option 1. The token is separate from the frontier's read-only token and is placed by hand in a file in EnvironmentFile format, `github-write.env`. It lives in `/var/lib/forge-credentials`, outside the run-writable state directory, and systemd never loads it: forge reads only `GITHUB_TOKEN` from it as data and puts that alone in the agent's environment, which keeps ADR-0015's guarantee that nothing a run writes changes what a later run loads. Managed repositories protect their default branch, so a run can open pull requests but never merge them.

## Consequences

Repository skills that orchestrate work through GitHub run on forge without change. A compromised run can push branches, open pull requests, and edit issues and labels in every managed repository, bounded by branch protection. Forge cannot trust a ticket's labels or pull requests as proof of what a run did, since the run could have written them.
