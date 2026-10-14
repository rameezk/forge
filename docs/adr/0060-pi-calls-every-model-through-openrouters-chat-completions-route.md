# 0060. Pi calls every model through OpenRouter's chat-completions route

## Status

Accepted

## Context

ADR-0013 makes a run's cost what OpenRouter billed, looked up by each generation's OpenRouter id. Since pi 1.0.0, pi sends `anthropic/*` models on the `openrouter` provider through OpenRouter's Anthropic Messages route, which returns Anthropic's own `msg_...` id instead of an OpenRouter `gen-...` id. OpenRouter's generation lookup rejects those ids with HTTP 400, so billing gives up on every generation: run `c40e5c6d` recorded 34 generations, about $0.36 at list price, and shows $0 unconfirmed. Other models still take the chat-completions route and bill normally.

- Option 1: Forge's `models.json` pins every model to OpenRouter's chat-completions route. One route for all models, the one billing already works with; OpenRouter carries prompt caching and reasoning for Anthropic models on it.
- Option 2: Keep the Anthropic Messages route and recover the OpenRouter generation id from that route, through another pi patch in the manner of ADR-0052. Unverified that the route exposes one, and a second patch to carry through every pi upgrade.
- Option 3: Settle such runs from forge's estimate. Contradicts ADR-0013, and the cost is never billed.

## Decision

We will go with Option 1. Every model forge runs on pi goes through OpenRouter's chat-completions route, so every generation carries an OpenRouter id billing can confirm. A real-pi contract test runs an Anthropic model and asserts its recorded ids are OpenRouter generation ids, When the runner records a generation whose id is not an OpenRouter generation id, it gives up on it at once with the reason as its last error, never sends it to OpenRouter, and the run page shows a warning that the harness returned ids that cannot be billed, rather than leaving billing to give up on it silently.

## Consequences

Anthropic models on pi bill like every other model. Forge gives up whatever the Anthropic Messages route offers beyond chat completions; if that loses prompt caching or reasoning for Anthropic models, this is a new decision, with Option 2 as the fallback. A future pi or OpenRouter change that returns a non-OpenRouter id fails the contract test, and if it reaches a box, shows up at once instead of as a quiet $0.
