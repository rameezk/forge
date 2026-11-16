# 0113. Forge does not take outside pull requests

## Status

Accepted

## Context

Forge is a public, MIT-licensed repository built from refined tickets that its own agents pick up and prove through CI. An outsider opened #818 implementing #626 while it was still labelled `ready-for-refinement`, guessing its scope. The repository had no contributing guidance, kept GitHub's default `good first issue` and `help wanted` labels, and offered no private route for a vulnerability report.

- Option 1: Closed to outside code. Outside pull requests are not reviewed, and GitHub's "Collaborators only" pull request setting stops them being opened. Outsiders contribute through issues.
- Option 2: Invite-only. Outsiders may take a `ready-for-human` ticket once assigned to it. Every outside change still needs review outside the agents' flow.
- Option 3: Open. Any pull request is reviewed on its merits, which invites drive-by work on unrefined tickets.

## Decision

We will go with Option 1. Pull request creation is limited to collaborators. Bug reports and ideas are welcome through issue forms, with blank issues off. Vulnerabilities are reported privately through GitHub's private vulnerability reporting, described in `SECURITY.md`. The `good first issue` and `help wanted` labels are removed. `CONTRIBUTING.md` states the policy and the README links to it.

## Consequences

Work enters Forge only as refined tickets, and no review time goes to outside code. Contributors who would have sent a fix send an issue instead. If the "Collaborators only" setting blocks pull requests from Forge's GitHub App, Dependabot or skills-sync, the setting goes back to everyone and an outside pull request is closed with a pointer to `CONTRIBUTING.md`. Opening up later, as in Option 2, is a new decision.
