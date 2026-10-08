# 0046. A worker can run on a Claude subscription through pi's anthropic provider

## Status

Accepted

Amends ADR-0008.

## Context

The operator wants workers to draw on a Claude Max subscription instead of paying OpenRouter per token. OpenRouter cannot bill against a subscription, so subscription runs must call Anthropic directly. Anthropic's terms have restricted subscription OAuth to Claude Code and claude.ai, enforced against third-party clients from January to April 2026 and relaxed in May and June. The locked pi 1.0.0 supports subscription OAuth on its `anthropic` provider by presenting itself as Claude Code: its user-agent, beta headers, a "You are Claude Code" system prompt line and Claude Code tool names. Under ADR-0040's read-only credential store, pi cannot refresh an `auth.json` OAuth login, but it accepts a long-lived `claude setup-token` token from `ANTHROPIC_OAUTH_TOKEN` and never refreshes it.

- Option 1: Claude Code as a second harness behind the `HarnessEvent` seam. Anthropic sanctions it for headless use, but subagents, skill loading and coverage, the agent dir, the credential patch and the transcript parser are all built on pi (ADR-0009, ADR-0023, ADR-0033, ADR-0037, ADR-0039, ADR-0040) and would need a second implementation.
- Option 2: pi with `--provider anthropic` and a setup token passed as `ANTHROPIC_OAUTH_TOKEN`. Everything built on pi carries over, but it relies on Anthropic tolerating pi's impersonation of Claude Code.
- Option 3: pi with an `auth.json` OAuth login it refreshes. Needs a writable credential store, undoing ADR-0040.
- Option 4: Move every worker to the subscription. Loses non-Claude models and puts all work under one set of usage limits.

## Decision

We will go with Option 2, per worker. A worker declares a provider, `openrouter` or `anthropic`, defaulting to `openrouter`. An `anthropic` worker names Anthropic's own model id, and pi's built-in catalog supplies its context window and limits, so the runner writes no `models.json` for it. The operator creates the token with `claude setup-token` and stores it in sops as `anthropic_oauth_token`. The runner passes it into the sandbox as `ANTHROPIC_OAUTH_TOKEN` and redacts it like the OpenRouter key. Subagents always use their workload's provider.

## Consequences

Subscription workers keep everything forge has built on pi. If Anthropic blocks pi's client again, only `anthropic` workers stop, and they can move back to `openrouter`. A subscription run's system prompt and tool names differ from the same worker on OpenRouter. The token lasts about a year and is rotated by hand. ADR-0008's guarantee that cost always comes from OpenRouter no longer holds for every run.
