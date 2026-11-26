# 0128. Operators reach forge from their agents through a local MCP server

## Status

Accepted

## Context

Operators want their own agents to see forge's state, claim tickets and dispatch them (ADR-0125, ADR-0126). The main users are local coding agents, which all have a shell and speak MCP, but starting a ticket from a desktop chat client without a terminal is also worth supporting.

- Option 1: A local MCP server. Works in coding agents and desktop chat clients alike, at the cost of tool schemas in each client's context and a one-time registration per client.
- Option 2: A local `forge` CLI with a skill teaching agents to use it. Usable by people at a terminal and free when idle, but unreachable from clients without a shell.
- Option 3: Both, a CLI and an MCP server over one command module. Every client and person is covered, but two surfaces must be kept, tested and distributed from day one.

## Decision

We will go with Option 1. The server runs on the operator's machine over stdio, reads forge's state from the box's read-only API over the tailnet, and writes to GitHub with the operator's own identity, never forge's App, so a dispatch it starts is the maintainer's approval (ADR-0079). Its commands sit behind one module with the MCP server as its adapter.

## Consequences

One surface serves terminal agents and desktop clients. A person at a terminal still uses `gh` and the dashboard, and a CLI can be added later as a second adapter over the same module. No forge skill is needed to claim or work a ticket: the tools describe themselves, and the work itself is the repository's own skills'. The server needs the operator's GitHub login and tailnet access wherever its client runs.
