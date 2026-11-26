# 0129. The local MCP server has no authentication of its own

## Status

Accepted

## Context

The local MCP server (ADR-0128) reads the box and writes to GitHub as the operator. Its real risk is an agent steered by text someone else wrote into dispatching a ticket, which spends money and runs code on the box (ADR-0079).

- Option 1: Guard the server itself: a shared secret per client, a dedicated narrow GitHub token, and a server-side preview-then-confirm step for writes. Each guard sits inside what the operator's own user, or the agent, can already reach.
- Option 2: Rely on the boundaries that exist: stdio only, the operator's `gh` login, the client's own approval prompt for writes, and the tailnet for reads.

## Decision

We will go with Option 2. The server runs over stdio only and authenticates no caller. It writes with the operator's `gh` login and never sends that token to the box. Its read tools carry MCP's `readOnlyHint` and its write tools do not, so clients ask a person before each `dispatch`, `claim` or `release`. It keeps its own refusals, such as a ticket that is not `ready-for-agent`. The box's JSON interface is open to the tailnet, exactly like the dashboard (ADR-0020).

## Consequences

The human check on a write is the client's approval prompt, so an operator who always allows `dispatch` in a client removes it there; forge's budgets and review limit still bound the damage. Offering the server over HTTP would be a new decision that brings authentication with it. Narrowing who on the tailnet can read forge's state is one decision covering the dashboard and the JSON interface together.
