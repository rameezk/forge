# 0097. A workload loads no MCP servers from its repository

## Status

Accepted

## Context

A workload's commands are moving into a separate process namespace so they cannot signal the harness, and nothing the agent can write may run beside the harness. Claude Code starts a stdio MCP server through its shell prefix, but applies the server's `env` block to the process it spawns, which runs beside the harness. A `.mcp.json` with `"env": {"LD_PRELOAD": ...}` therefore runs agent-written code next to the harness. No repository forge works on ships a `.mcp.json` today.

- Option 1: Load no MCP servers from the repository. Nothing is lost today; a repository that wants MCP servers cannot have them.
- Option 2: Forge reads the repository's `.mcp.json` and generates its own MCP config, carrying each server's `env` to the command broker as data so it applies only inside the commands' namespace. Repository MCP servers keep working, but forge owns a translation of Claude Code's MCP config format.

## Decision

We will go with Option 1. Neither harness loads MCP servers from the workload's repository.

## Consequences

A repository's `.mcp.json` has no effect on a workload. Supporting repository MCP servers later is a new decision, starting from Option 2, and must keep the server's environment off every process that runs beside the harness.
