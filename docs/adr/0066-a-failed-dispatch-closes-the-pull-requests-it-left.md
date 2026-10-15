# 0066. A failed dispatch closes the pull requests it left

## Status

Accepted

## Context

Under ADR-0065 a dispatch can fail after its agent opened a pull request, most often a draft whose checks never went green. A retry runs from scratch and opens a new pull request, so the old one would sit beside it claiming to close the same ticket. Forge must also not publish its internals, such as failure reasons, limits or dashboard links, to GitHub.

- Option 1: Close forge's pull requests for the ticket when the dispatch fails. One place, at the moment forge already holds the pull request; taking over the attempt means reopening it.
- Option 2: Leave them open and close them when a retry is picked up. The failed work stays visible, but forge needs a second lookup and close at claim time.
- Option 3: Never close, and refuse a retry while one is open. Forge never closes anything, but every retry needs a manual step.
- Option 4: Never close, and let retries pile up. Old pull requests need tidying by hand.

## Decision

We will go with Option 1. When a dispatch fails, including one settled later as interrupted, forge closes every open pull request closing the ticket that its GitHub App authored, draft or ready, keeps the branch, and leaves one fixed note that names only the ticket, such as "Closed because this attempt at #50 did not complete." A pull request authored by a person is never touched.

## Consequences

A ticket never has more than one open forge pull request, and a retry starts clean. Anyone browsing the repository sees why the attempt closed without seeing anything of forge's internals, which stay on the dashboard. Taking over a failed attempt means reopening its pull request first.
