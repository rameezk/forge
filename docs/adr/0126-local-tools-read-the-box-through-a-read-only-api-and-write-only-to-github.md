# 0126. Local tools read the box through a read-only API and write only to GitHub

## Status

Accepted

## Context

An operator's local agent should see what forge knows, such as the frontier, what is running and why a dispatch failed, and should be able to claim or dispatch tickets. Outcomes, failure reasons, transcripts and costs live only in the box's store, and the dashboard that shows them is read-only HTML with no JSON API (ADR-0016, ADR-0010).

- Option 1: A read-only JSON API on the box, served over the tailnet beside the dashboard, and nothing else. Local tools see forge's state but cannot claim or dispatch.
- Option 2: Local tools read and write only GitHub. No box changes, but no failure reasons, transcripts or costs.
- Option 3: Local tools read forge's state from a read-only JSON API on the box over the tailnet, and make every change on GitHub, through assignees and `forge:*` labels.

## Decision

We will go with Option 3. The box gains a read-only JSON API reachable only over the tailnet (ADR-0020), and accepts no writes from outside. Claiming and dispatching stay GitHub operations, as they are for people today.

## Consequences

Every change forge reacts to still lives on GitHub, so the claim survives anything that happens to the store and no new write path reaches the box. Local tools need tailnet access to read forge's state. The JSON API becomes a contract the box keeps for its local clients, beside the dashboard.
