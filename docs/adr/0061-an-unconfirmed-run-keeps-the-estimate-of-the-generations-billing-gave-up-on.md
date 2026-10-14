# 0061. An unconfirmed run keeps the estimate of the generations billing gave up on

## Status

Accepted

Amends ADR-0013 and ADR-0032.

## Context

ADR-0032 shows forge's estimate for a generation until OpenRouter bills it. Once billing gives up on a generation, its estimate is dropped, so an unconfirmed run shows only what was billed. When billing gave up on every generation, as in run `c40e5c6d`, a run that cost about $0.36 at list price reads `$0.000000 unconfirmed`, and the dashboard total, cohort and insights figures leave that spend out.

- Option 1: Keep ADR-0013's rule that only billed money is shown once billing gives up. Nothing unbilled is shown as cost, but a run's spend can vanish to $0.
- Option 2: A given-up generation keeps its estimate. An unconfirmed run shows its billed cost and the estimate of what billing gave up on as separate, labelled figures, and totals and budgets count both.
- Option 3: As Option 2, but totals and budgets count only billed cost. The run page is honest, but the totals still under-report.

## Decision

We will go with Option 2. A generation billing gives up on keeps the estimate forge priced it at. An unconfirmed run shows what OpenRouter billed and, apart from it, the estimate of the generations billing gave up on, for example `$0.00 billed + ~$0.36 unconfirmed estimate`. The dashboard total, charts and the budget check count that estimate, kept visibly apart from billed cost as ADR-0032 already does for pending runs.

## Consequences

A run's spend never silently drops to $0 because billing could not confirm it, and a budget sees money that was probably spent. Totals carry unconfirmed estimates indefinitely, so they never fully settle to billed cost while any unconfirmed run is counted. A generation forge could not price, with no list price recorded at run start, still contributes nothing, as ADR-0032 already says.
