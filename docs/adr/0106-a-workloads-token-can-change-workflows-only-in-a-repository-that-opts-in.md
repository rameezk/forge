# 0106. A workload's token can change workflows only in a repository that opts in

## Status

Accepted

Amends ADR-0049.

## Context

Every workload token carries Workflows: write, which GitHub requires to push a commit touching `.github/workflows`. A leaked token can use it to push a workflow that runs at once on its branch, reads every repository-level secret, asks for an elevated built-in token, or rewrites the checks on its own pull request. ADR-0105's rules keep that code off the default branch, but not those side effects. Few tickets touch workflows outside forge itself. Re-running failed runs needs Actions: write (ADR-0089), not Workflows: write.

- Option 1: Keep Workflows: write on every workload token.
- Option 2: Request it only for a repository that sets `workflows = true`, and allow that only on a repository passing ADR-0105's rules.
- Option 3: Never request it, and change workflows by hand.

## Decision

We will go with Option 2. The App installation keeps Workflows: write, so opting a repository in needs no change on GitHub.

## Consequences

A token leaked from a repository that has not opted in cannot change its workflows. In such a repository, a ticket that needs a workflow change fails at push, and the operator either opts the repository in or makes the change by hand. A leaked App private key can still mint Workflows: write for every installed repository. Re-running failed runs is unaffected.
