# 0117. Forge dispatches the frontier by urgency grade, then repository priority, then age

## Status

Accepted

Builds on ADR-0016 and ADR-0103.

## Context

A box with one runner serves many managed repositories and dispatches `forge:ready` frontier tickets oldest first, so a fresh bug, or a ticket for forge itself, waits behind every older ticket in every other repository. How urgent a ticket is often hinges on context the ticket does not state, such as whether its repository is live.

- Option 1: Keep oldest first.
- Option 2: Order by a kind label (`bug` first), then repository priority, then age. Exact, but it relies on every author labelling, and a label says nothing about how much a bug matters.
- Option 3: Order by a weighted score over several factors. Flexible, but hard to predict or explain.
- Option 4: Order in tiers: a Jev urgency grade, then a repository priority the operator sets, then age.

## Decision

We will go with Option 4. Jev reads the ticket and its parent spec as ADR-0079 builds them, titles, bodies and maintainers' comments only, together with an operator-written description of the repository from the operator config, and answers with one of four levels: `critical` (something live is broken or losing data now), `high` (a defect users can hit, or work blocking other people), `normal` (planned feature or improvement work) and `low` (cleanup, docs or nice-to-have work). An uncertain grade counts as `normal`. Forge labels the ticket with its most likely level as `forge:urgency-<level>`, adding `forge:urgency-uncertain` when the grade is uncertain, swaps the labels on a regrade, and leaves them after dispatch. A ticket is graded when it gets `forge:ready` and again when its title or body changes. Repository priority is an integer, 0 by default, higher first. A frontier ticket takes the highest tier of any queued ticket it blocks, directly or through other blockers. Forge grades every managed repository's tickets, but the order stays oldest first until the operator switches it to urgency in the operator config, once the grades the labels show on real tickets match the maintainer's own judgement; if they never do, we go with Option 2 instead.

## Consequences

Critical work in any repository goes ahead of forge's own features, and among equally urgent work the higher priority repository goes first. The grade only orders: it never holds back or refuses a ticket, so a ticket written to sway Jev can at most jump the queue. Each grade is a costed Decisions API call under ADR-0103's exemption for typed, tool-free calls. Repository docs and live signals such as failing CI are not read, so a misgrade from missing context is fixed by a later decision to send more. Strict tiers can hold a low priority repository back for as long as higher tiers have work.
