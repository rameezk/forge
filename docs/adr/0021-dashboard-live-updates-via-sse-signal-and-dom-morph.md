# 0021. Dashboard live updates via an SSE change signal and a DOM morph

## Status

Accepted

## Context

The dashboard is server-rendered with no client JS, so new runs, settling costs, frontier polls and a growing transcript only show after a manual refresh. Its data is written by other processes - the runner, the billing timer, the frontier poller - so the dashboard cannot learn of changes from its own writes.

- Option 1: A timed full reload with `<meta refresh>`. No JS, but it resets scroll and collapses opened `<details>`, which makes a transcript unusable.
- Option 2: A client poller that swaps in HTML fragments from per-region endpoints. Works, but every live region gets a second render path to keep in step with the page.
- Option 3: The server pushes a bare "changed" signal over SSE, and the client re-fetches the same page and morphs the DOM with a self-hosted idiomorph, keeping scroll and open `<details>`. About once a second the server checks SQLite `PRAGMA data_version` and the transcript file's size, and when either moved it renders the page itself and signals only if the HTML's hash differs from the last one sent.
- Option 4: htmx with its SSE extension. The same shape as Option 3, but a larger dependency and its attribute dialect spread through the templates.

## Decision

We will go with Option 3 on every page: the runs list, the work page and a run's detail. The script is served self-hosted like the stylesheet (ADR-0014), and live updates are a progressive enhancement: with JS off or the stream down, every page still works as plain server-rendered HTML.

## Consequences

The full page stays the single render path, so a live update can never disagree with a refresh, and a signal always means the page really looks different. The dashboard now ships client JS and holds one open connection per viewer, and it polls its own change sources rather than being told of writes. Update latency is bounded by the writers themselves - the billing timer and the frontier poll interval - rather than by the dashboard.
