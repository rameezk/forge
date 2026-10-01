# 0013. Run cost settles after the run, and shows as pending until billed

## Status

Accepted, amended by ADR-0028

## Context

ADR-0008 made OpenRouter's billed cost the source of run cost, looked up per generation as the run finishes. On the first live run OpenRouter indexed the generation about 90 s after it completed, while the runner gave up after about 7.5 s, so a real run was recorded at $0 and marked uncertain. pi's catalog estimate matched the bill for a model it knows, but pi silently prices a model missing from its catalog at its default model's rates, carries some paid OpenRouter models at $0, and discards the cost OpenRouter returns inline.

- Option 1: Keep the lookup blocking in the runner with a budget of minutes. Simple, but every run holds its worker for the indexing lag.
- Option 2: Record pi's catalog estimate when the run finishes and replace it with the billed cost later. A number is visible at once, but a wrong estimate looks like a real cost.
- Option 3: As Option 2, but drop the estimate when it is known to be bad (fallback warning, or $0 with tokens). Narrows the risk, but depends on a stderr string pi does not promise to keep.
- Option 4: Finalize the run without a cost, show it as pending, and fill in the billed cost when OpenRouter has it.

## Decision

We will go with Option 4. A run's cost is only ever what OpenRouter billed. Until that is known the run shows as pending, and pi's estimate is never recorded or shown. The runner persists each generation id, and a separate billing service on a systemd timer settles them after the runner exits, giving up on a generation after 24 hours. A run whose runner is killed never ends, so once it has had no generation for 24 hours forge gives up on it as well, since later generations may be unrecorded. A run's cost status is pending, billed, or unconfirmed.

## Consequences

Runs finish without waiting on OpenRouter, and nothing wrong is shown as a cost. Settling survives restarts and never holds a worker, at the price of a second unit writing the store alongside the runner. For about a minute or two after each run, the dashboard total leaves that run's cost out.
