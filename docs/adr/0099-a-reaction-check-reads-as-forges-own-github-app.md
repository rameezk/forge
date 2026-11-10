# 0099. A reaction check reads as forge's own GitHub App

## Status

Accepted

Amends ADR-0062 and ADR-0093.

## Context

Forge decides whether feedback is acknowledged (ADR-0093) or answered by a 👍 (ADR-0062) by finding its App among a reaction's reactors. GitHub rejects any query whose static node count, the product of nested page sizes computed from the query text alone, exceeds 500,000. `FeedbackWindow` nested `reviews(last: 100)`, `comments(first: 100)` and `reactors(first: 100)` for 1,000,000 nodes, so the frontier sync failed on every watched pull request and no 👀 was ever posted. `FeedbackAnswers` stood at 400,000.

- Option 1: Shrink the reactors page, e.g. `reactors(first: 50)`. Sits exactly at the limit and misses forge's reaction behind 50 other reactors.
- Option 2: Drop the reactors connection and read `ReactionGroup.viewerHasReacted`, which is true when the identity sending the query left that reaction. Both queries fall to about 10,000 nodes, but the answer depends on which token sends the query.

## Decision

We will go with Option 2. Feedback is acknowledged when its 👀 group has `viewerHasReacted`, and answered by reaction when its 👍 group has it. The old check that the 👍 came after the item was always true and goes away. Every query that reads `viewerHasReacted` is sent with an installation token from the same App that leaves the reactions. A probe on 2026-11-10 confirmed it: after the App's reactions token put a 👀 on a comment, the App's read token saw `viewerHasReacted` true on that group and false on every other.

## Consequences

The feedback queries stay well under GitHub's limit, and a test holds every query forge sends to it. Sending a reaction query with any other identity, such as a personal access token, raises no error: every item would read as unacknowledged and unanswered, so forge would re-add 👀 every poll and fail revisions it had answered.
