# 0093. Forge acknowledges each item of feedback with an eyes reaction when it sees it

## Status

Accepted

Amends ADR-0050 and ADR-0062.

## Context

A revision starts only once feedback has been quiet for `feedback.quietPeriod` (10 minutes by default), plus up to one frontier poll. Until then a reviewer sees nothing from forge and cannot tell whether their comment was noticed. Forge has no webhooks (ADR-0020), so any acknowledgement comes from polling.

- Option 1: Acknowledge nothing before the revision replies. No new GitHub writes, but reviewers wait 10 to 15 minutes with no sign of life.
- Option 2: A separate fast timer that only adds acknowledgements. Quicker, but another unit and more GitHub calls per watched pull request.
- Option 3: The frontier sync adds a 👀 reaction from forge's App to every item of feedback it has not yet reacted to, reading the App's existing reactions from GitHub rather than keeping state.

## Decision

We will go with Option 3. A 👀 goes on exactly the items a revision would be given (ADR-0062): review summaries with a body, every inline review comment including thread replies, and every conversation comment. It goes on only when the author is a maintainer, the pull request was opened by forge's App, the repository names `on.feedback`, and the item is newer than the cursor. That includes feedback left while a revision is running. The sync uses its own installation token, which can write issues and pull requests and is used for nothing else. A failed reaction is logged and fails the sync like any other write, without stopping it from recording watched pull requests, and the next poll retries it. The 👀 stays after the item is answered, and it never counts as an answer.

## Consequences

Reviewers see their feedback acknowledged within one poll interval, well inside the quiet period, and a 👀 means forge will act on that comment. Comments from people who are not maintainers, and feedback already consumed, never get one. If a person removes forge's 👀, the next sync puts it back. Each sync makes one extra query per watched pull request, plus one write per new item. Lowering `frontier.pollInterval` is how an operator makes acknowledgements faster.
