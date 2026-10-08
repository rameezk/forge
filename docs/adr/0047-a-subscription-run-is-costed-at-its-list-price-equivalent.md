# 0047. A subscription run is costed at its list-price equivalent

## Status

Accepted

Amends ADR-0013, ADR-0032 and ADR-0045.

## Context

ADR-0046 lets a worker run on a Claude subscription. Anthropic bills no generation of such a run, so there is no billed cost to settle, and ADR-0045 fails closed on spend it cannot price. OpenRouter charges Anthropic's list price for Anthropic's models, so a subscription run's tokens at that price are what the same run would have cost on OpenRouter. pi's catalog price was rejected in ADR-0032 because pi guesses prices for models it does not know; it knows Anthropic's own models on the `anthropic` provider.

- Option 1: A `subscription` cost status with no dollar figure. Cost comparisons with OpenRouter runs are lost, and budgets cannot apply.
- Option 2: A `subscription` cost status plus a list-price equivalent: the run's tokens at pi's catalog price for the model, kept apart from billed cost everywhere, with the USD budget enforced against it.
- Option 3: Record subscription runs at $0. Misleads cohort and insights comparisons, and turns every budget off.
- Option 4: As Option 2, but priced from OpenRouter's entry for the matching `anthropic/...` model. Needs a mapping between Anthropic and OpenRouter model ids.

## Decision

We will go with Option 2. A subscription run's cost status is `subscription` and it is never settled. Each generation's list-price equivalent is computed when it completes, from pi's token counts, cache reads and writes included, and pi's catalog price for the model. It is recorded and shown as a list-price equivalent, never as billed or estimated cost, and totals and charts keep it apart from billed spend. ADR-0045's budget is checked against it, so a budgeted subscription worker whose model pi cannot price is refused at start.

## Consequences

Subscription and OpenRouter runs of the same model compare in dollars and tokens, and runs of different models compare in dollars. The figure goes stale if Anthropic changes a price before forge upgrades pi. A subscription run's prompt carries pi's Claude Code identity line, so its tokens run slightly above the same run on OpenRouter. The billing service never sees subscription runs.
