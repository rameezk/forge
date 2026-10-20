# 0078. Maintainers are people with write access

## Status

Accepted

Supersedes ADR-0063.

## Context

ADR-0063 trusts feedback by its `authorAssociation`, counting `OWNER` and `COLLABORATOR`. Tickets on public repositories need the same protection, but there the actors to judge are who applied `forge:ready` and who edited a ticket's title or body. GitHub records those as a bare login on a `LabeledEvent`, `RenamedTitleEvent` or `UserContentEdit`, with no `authorAssociation`.

- Option 1: Keep `authorAssociation` for content, and look up repository permission only for label and edit actors. Two definitions of trust that disagree at the edges, such as a read-only outside collaborator.
- Option 2: Rely on GitHub's own gates, since only triage and above can label, except through issue templates. No extra calls, but it trusts triage and rests on reasoning about GitHub's permission model rather than on data.
- Option 3: Look up every actor's repository permission with `GET /repos/{owner}/{repo}/collaborators/{username}/permission`, trusting `write` and `admin`, for tickets and feedback alike. The endpoint needs only the `Metadata: read` permission every App has.

## Decision

We will go with Option 3. A maintainer is a person whose repository permission is `write` or `admin`. Only maintainers give feedback, and only maintainers can approve a ticket for dispatch. Bots are never maintainers.

## Consequences

Forge has one definition of trust, matching who could change the code anyway. Judging an actor costs one call per distinct login, cached for a pass. A read-only outside collaborator no longer gives feedback, and an organisation member with write access through a team now does.
