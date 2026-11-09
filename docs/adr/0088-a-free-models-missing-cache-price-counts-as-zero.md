# 0088. A free model's missing cache price counts as zero

## Status

Accepted

Amends ADR-0045.

## Context

OpenRouter lists a free model's `prompt` and `completion` price as `0` and omits `input_cache_read` and `input_cache_write`. Under ADR-0045 any generation with cache tokens is then unpriced and ends a budgeted workload `exceeded`, although it cannot cost anything, so free models fail at random depending on whether the provider serves from cache (issue #300).

- Option 1: When forge reads a model's list price and both its input and output prices are 0, it fills each missing cache price in as 0. A listed cache price is kept as listed, and a model with a non-zero input or output price keeps a missing cache price unknown.
- Option 2: As Option 1, but the estimator treats a missing cache price as 0 at estimate time. The list price recorded on the run then disagrees with what forge prices with.
- Option 3: Recognise free models by the `:free` suffix of their id. Ties pricing to a naming convention rather than to the price OpenRouter lists.

## Decision

We will go with Option 1. It applies wherever forge prices from the list price, so to estimated cost and to a subscription workload's list-price equivalent alike.

## Consequences

A free model's generations are estimated at 0 and never end its workload on its budget. A paid model with a missing cache price still fails closed, so forge never guesses a cache price that could cost money.
