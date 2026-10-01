# 0032. An unbilled generation shows an estimate forge prices itself

## Status

Accepted

Amends ADR-0013 and ADR-0028.

## Context

ADR-0013 never records or shows a harness's cost estimate, and ADR-0028 shows a pending run's billed cost so far. Billed cost trails each generation by OpenRouter's indexing lag, so a live run's cost and tokens lag behind what it is spending. pi reports each generation's tokens, with the cache split, as soon as it completes, and also a cost. For a model missing from pi's catalog, pi clones a default model and keeps its prices: the first live dispatch ran `anthropic/claude-opus-5.5` priced as `moonshotai/kimi-k2.6`, several times too cheap.

- Option 1: Keep ADR-0028: show only billed cost so far, and tokens only once known.
- Option 2: Show pi's tokens and pi's cost until OpenRouter's figures arrive. The cost is wrong whenever pi's catalog lacks or misprices the model.
- Option 3: Show pi's tokens, and an estimate forge computes from them and OpenRouter's list price for the model, until OpenRouter's native token counts and billed cost replace them.

## Decision

We will go with Option 3. At run start forge records OpenRouter's list price for the worker's model from its models endpoint. Each generation's tokens come from pi when it completes and are replaced by OpenRouter's native counts once billed. Until a generation is billed, its cost is forge's estimate from pi's tokens and the recorded price, and a run whose cost includes any estimate is marked as estimated. pi's own cost is still never recorded or shown.

## Consequences

A run's tokens and cost move as it runs, and the estimate does not depend on pi's catalog. An operator sees estimated figures for a minute or two per generation, so the dashboard has to keep estimated and billed visibly apart. The total adds estimates for pending runs, so it can move down slightly when a generation is billed below its estimate. Forge depends on OpenRouter's models endpoint at run start; if it fails, the run's unbilled generations show no estimate rather than a guess.
