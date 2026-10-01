# 0028. A pending run's billed cost so far is shown, marked as partial

## Status

Accepted

Amends ADR-0013.

## Context

ADR-0013 shows a run's cost as pending until OpenRouter has billed every generation, and says generations are settled after the runner exits. In practice the billing timer settles every unsettled generation each minute, including those of runs still going, so the store already holds a billed-so-far cost that the dashboard hides. A run that has ended but is still waiting on OpenRouter's indexing lag hides real billed cost the same way.

- Option 1: Keep showing only `pending`. Nothing partial is ever on screen, but an operator cannot see what a long run is spending while it runs.
- Option 2: Show the billed-so-far cost of any pending run above $0, marked with a `pending` badge, and add it to the dashboard total, which keeps its `+N pending` suffix.
- Option 3: As Option 2, but leave pending runs out of the dashboard total. The total only moves when a run settles, while unconfirmed runs' partial cost is already in it.

## Decision

We will go with Option 2. A pending run whose billed cost is above $0 shows that cost with a neutral `pending` badge, explaining that it rises as generations are billed and trails them by a minute or two. A pending run at $0 still shows only `pending`. The dashboard total adds every run's billed cost, pending ones included, and `+N pending` marks that it is still rising. The figure is still only ever what OpenRouter billed. Billing settles generations every minute, during a run as well as after it.

## Consequences

An operator can watch a run's spend while it runs, and the total rises steadily rather than jumping when a run settles. A pending figure trails the run, so it is always an underestimate until the run is billed, and the badge is what keeps it from reading as final. ADR-0013's consequence that the total leaves a just-finished run's cost out no longer holds.
