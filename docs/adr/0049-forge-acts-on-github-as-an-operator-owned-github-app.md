# 0049. Forge acts on GitHub as an operator-owned GitHub App

## Status

Accepted

Supersedes ADR-0017. Amends ADR-0010 and ADR-0029.

## Context

Forge is to watch its pull requests for review feedback and act on it without an operator relabelling anything. Today the write token (ADR-0017) is a fine-grained token on the operator's own account, so forge's pull requests, pushes and agent replies are all authored by the operator. Forge cannot tell a reviewer's feedback from its own activity, and the operator cannot request changes on a pull request their account opened.

- Option 1: Keep the operator's token and treat whatever the token owner wrote while a workload ran on that pull request as forge's own. Brittle, and the operator still cannot request changes.
- Option 2: A dedicated machine-user account holding the write token. No new token code, but fine-grained tokens cannot reach repositories where the account is only a collaborator, forcing a broad classic token; every onboarded repository needs an invite accepted as the bot; it takes a seat in a paid organisation; and the token needs rotating.
- Option 3: An operator-owned GitHub App. Forge signs a JWT with the App's private key and mints installation tokens, which expire after an hour and can be narrowed to chosen repositories and permissions.

## Decision

We will go with Option 3. Each operator creates their own App and puts its id and private key in their sops secrets; onboarding a repository is selecting it in the App's installation. Forge mints each workload a token for that workload's repository alone, with only the permissions a run needs, and the runner, outside the workload sandbox, keeps it fresh in a file the sandbox reads but cannot write. Git's credential helper and a `gh` wrapper read that file. The frontier sync mints its own read-only installation token, so the two personal access tokens go away.

## Consequences

Forge's GitHub activity is authored by the App's bot account, distinguishable from every person, and operators can review forge's pull requests like anyone else's. A compromised run can reach only its own repository, for at most an hour after its run ends. The operator holds one GitHub credential instead of two, with nothing to rotate. Forge takes on JWT signing, installation lookup and mid-run token refresh, and a repository missing from the installation fails at sync rather than at dispatch. Each repository owner, user or organisation, needs its own installation.
