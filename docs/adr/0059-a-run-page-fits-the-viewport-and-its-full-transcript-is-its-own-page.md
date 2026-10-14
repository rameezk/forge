# 0059. A run page fits the viewport and its full transcript is its own page

## Status

Accepted

## Context

A run's detail page stacks a long details list, the calls table and the whole transcript top to bottom, so most of it sits below the fold and a wide screen's width goes unused. The dashboard is server-rendered with no client-side framework (ADR-0014), and live updates re-render the whole page and morph it (ADR-0021).

- Option 1: Keep one stacked page and collapse its sections by default. Least change, but the page stays a long vertical scroll.
- Option 2: Fit the run page to the viewport in two columns, the run's figures on the left and a transcript widget of the latest events on the right, and open the full transcript as a same-page overlay through `:target`. No JS, but filtering still needs links that reload the page, so the overlay gains little over a page.
- Option 3: The same two columns, with the full transcript as its own page at `/runs/:id/transcript`, filtered by query links such as `?show=errors` and addressable per event by anchor.
- Option 4: The same two columns, with the full transcript in a `<dialog>` opened by a script. Feels most app-like, but adds client JS and the back button does not close it.

## Decision

We will go with Option 3. The run page's widget shows the latest events as one-line rows, newest first, and every way into the full transcript - expand, first error, a row - is a link to its page.

## Consequences

The run's figures stay in view while the transcript is read, and a filtered transcript or a single event is a link that survives the back button. The run page now has two scroll regions, and the transcript has two renderings, the widget and the full page, that live updates keep current as they do every other page. Narrow screens stack the columns, so the layout carries breakpoints it did not have before.
