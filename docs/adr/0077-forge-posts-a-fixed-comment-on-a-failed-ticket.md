# 0077. Forge posts a fixed comment on a failed ticket

## Status

Accepted

## Context

The unattended ticket instruction told the agent to post why it stopped as a comment on its pull request, or on the ticket when it had none. Some repositories forge works on are public, forge included, and those notes carried internal detail: worktree paths, uncommitted state, gaps in the box's environment (#397, #399). Forge already records the same reason in the dispatch record and shows it on the dashboard, which is reachable only over the tailnet.

- Option 1: Keep the agent posting, but tell it to post only a fixed sentence. Cheap, but one slip by the model leaks detail into a public repository.
- Option 2: The agent never comments about stopping, and forge's runtime posts one fixed comment on the ticket when a dispatch fails. The wording cannot leak anything, but a question the agent needs answered is visible only on the dashboard.
- Option 3: Make detailed comments a per-repository setting for private repositories. Two behaviours to build and reason about, for detail that is one click away on the dashboard.

## Decision

We will go with Option 2. When a ticket dispatch settles as failed, for any failure reason, forge posts "Forge could not finish this ticket. Details are on the forge dashboard." on the ticket, once per failed dispatch, on every repository. The comment carries no link, since the dashboard's tailnet hostname would leak. The unattended instruction no longer asks the agent to comment when it is blocked or has a question.

## Consequences

Ticket comments reveal nothing beyond the fact that an attempt failed, and the operator reads the reason or question on the run page. A ticket retried several times collects one comment per failed attempt. Revision runs still answer feedback and post their blocked reasons or questions as detailed replies on the pull request, and conflict resolutions still post nothing. Comments posted before this decision are left in place.
