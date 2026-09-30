# 0016. Dispatch is opted into per ticket with forge lifecycle labels

## Status

Accepted

## Context

Forge knows the agent frontier of each managed repository (ADR-0010) but never acts on it. Dispatch has to decide which frontier tickets forge runs a workload against, and how a ticket is kept from being picked up twice.

- Option 1: Dispatch every frontier ticket automatically. `ready-for-agent` already says an agent may take the ticket, but an operator cannot hold work back from forge without taking it off the agent frontier altogether.
- Option 2: An operator starts each ticket by hand with a command on the box. Nothing runs without a person logging in, and a spec's tickets cannot be queued in dependency order.
- Option 3: A forge label on the ticket opts it in, and forge dispatches it once it is also on the frontier. Forge swaps the label as the run progresses, so the claim and its state live on the ticket.
- Option 4: As Option 3, but the label is a static opt-in and claims live only in forge's store. GitHub cannot show what forge is doing, and losing the store can run a ticket twice.

## Decision

We will go with Option 3. A ticket is dispatched when it is on the frontier and labelled `forge:ready`; either condition alone does nothing, so labelling a still-blocked ticket queues it until its blockers close. Forge claims a ticket by replacing `forge:ready` with `forge:running`, and ends it with `forge:done` when the run leaves an open pull request that closes the ticket, however the run itself ended, or `forge:failed` otherwise. An operator retries by setting `forge:ready` again. The label names are fixed. These labels are the only thing forge writes to a ticket: it never comments, links runs, or posts logs to GitHub, and why a dispatch failed is shown only on forge's dashboard.

## Consequences

Operators queue a whole spec by labelling its tickets, and forge works through them as their blockers close. GitHub shows each ticket's dispatch state, and the claim survives anything that happens to forge's store. Nothing about a box, its runs or their transcripts leaks into a repository's issues, so an operator reads a failure's reason on the dashboard, not on the ticket. Forge itself now needs write access to issues in every managed repository, which the frontier's read-only token does not give. Two forge deployments cannot share a repository while the label names are fixed.
