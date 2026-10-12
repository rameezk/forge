# 0054. A subscription worker runs on the Claude Code harness

## Status

Accepted

Supersedes ADR-0046.

## Context

ADR-0046 ran subscription workers on pi's `anthropic` provider, relying on Anthropic tolerating pi presenting itself as Claude Code. That was never checked against Anthropic's real API: every `anthropic` fixture came from a fake endpoint. On 2026-10-12 the first real run was refused with `400 invalid_request_error` "You're out of extra usage" while the plan stood at 2% of its session and 4% of its week, so Anthropic bills pi's subscription requests as third-party usage against usage credits, not plan limits. The unmodified `claude -p`, authenticated with a `claude setup-token` token in `CLAUDE_CODE_OAUTH_TOKEN` and no `ANTHROPIC_API_KEY`, succeeded with no usage credits, so it draws on the plan.

- Option 1: Claude Code as a second harness behind the `HarnessEvent` seam, ADR-0046's Option 1. Subagents, skill loading, the agent dir, credentials and event parsing need a second implementation.
- Option 2: Keep pi's `anthropic` provider and pay through usage credits. Per-token billing with no subscription benefit, and the `subscription` cost status would misreport real spend.
- Option 3: Make pi send Claude Code's billing header, as `@gotgenes/pi-anthropic-auth` does. It works by misreporting the client to evade Anthropic's enforcement of its terms, and breaks whenever Anthropic changes the check.
- Option 4: Retire the `anthropic` provider and run every worker on OpenRouter. Gives up the subscription.

## Decision

We will go with Option 1. A subscription workload runs the unmodified Claude Code CLI headless with the operator's setup token, and the runner makes sure no `ANTHROPIC_API_KEY` reaches it. Forge reads its telemetry from Claude Code's documented outputs, the stream-json event stream and OpenTelemetry events with raw API bodies written to a file, and never from its internal session transcript.

## Consequences

Subscription workers draw on the plan through a client Anthropic sanctions for this use. Forge maintains two harness adapters, and a subscription run's subagents, skills, prompt and tools are Claude Code's, not pi's, so it never shares a cohort with a pi run. pi's `anthropic` provider is no longer used. ADR-0047's pricing from pi's catalog and ADR-0048's fingerprint rule need revisiting for this harness. A change on Anthropic's side to how `claude -p` is billed would again stop subscription workers.
