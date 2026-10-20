# 0063. Only owners and collaborators give feedback

## Status

Superseded by ADR-0078

Amends ADR-0050.

## Context

ADR-0050 counts every comment by a person as feedback, and ADR-0062 puts feedback text into a revision's instruction. On a public repository a stranger's comment would then start a revision, spend the operator's budget, and become text the worker acts on.

- Option 1: Keep counting every person. Simple, but anyone on GitHub can steer a revision.
- Option 2: Ask GitHub for each author's permission on the repository. Exact, but one extra call per author and likely a wider App permission.
- Option 3: Use the `authorAssociation` GitHub sets on every review and comment, and count only `OWNER` and `COLLABORATOR`. GitHub computes it, so an author cannot forge it, and it comes in the query forge already makes.

## Decision

We will go with Option 3. A review or comment whose author is not the repository's owner or an invited collaborator neither starts a revision, resets the quiet period, nor reaches a revision's instruction. `MEMBER` is left out because organisation membership does not imply access to the repository.

## Consequences

Outsiders can comment freely without forge acting on it. An organisation member who reviews forge's pull requests must be added to the repository as a collaborator. A read-only outside collaborator on an organisation repository still counts, since the operator chose to invite them.
