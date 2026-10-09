# 0051. Forge's commits are authored by its GitHub App's bot

## Status

Accepted

Amends ADR-0026.

## Context

ADR-0026 took the commit identity from an operator option, `dispatch.gitIdentity`, because the token's owner was the operator. With forge acting through its own GitHub App (ADR-0049), pull requests and comments show as the App's bot while commits would still show whatever identity the operator configured.

- Option 1: Keep `dispatch.gitIdentity`. Operators choose any name, but forge's work appears under two identities.
- Option 2: Derive the identity from the App: `<app-slug>[bot]` and its `users.noreply.github.com` email, looked up once from the App's own details.

## Decision

We will go with Option 2 and remove `dispatch.gitIdentity`. The runner still sets the identity through `GIT_AUTHOR_*` and `GIT_COMMITTER_*`, as ADR-0026 decided.

## Consequences

Every trace forge leaves on GitHub, commits included, links to the App's bot. Rework becomes the commits on a pull request not authored by the App. Operators lose the choice of commit name, and configs setting `dispatch.gitIdentity` must drop it.
