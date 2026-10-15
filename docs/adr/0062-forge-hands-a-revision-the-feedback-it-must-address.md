# 0062. Forge hands a revision the feedback it must address

## Status

Accepted

Amends ADR-0050.

## Context

ADR-0050 passes a revision worker only the pull request's identity and leaves its skill to find the feedback. On pull request #414 a review summary started a revision, but `/git-pr-address-comments` reads only unresolved review threads, found nothing, and ended in success. The cursor had already moved past the review, so it was silently dropped. Review summaries and conversation comments have no resolved state, so a skill cannot tell new feedback from feedback already handled; only forge, which owns the cursor, knows which feedback started the revision.

- Option 1: Fix the skill alone to read every kind of feedback and guess which is new. Forge stays out of it, but every configured skill must get the same guess right.
- Option 2: Forge appends pointers to the new feedback to the revision's instruction and the skill fetches it. Shorter instruction, but the skill can still misread or miss what it was pointed at.
- Option 3: Forge appends the full text and URL of every item of new feedback to the revision's instruction, and the worker addresses exactly that list.

## Decision

We will go with Option 3. When a revision starts, forge reads the pull request's review summaries, inline review comments and conversation comments that count as feedback and fall between the previous cursor and the revision's start, and lists each one's kind, author, location, URL and body in the revision's instruction. An empty window ends the revision as ok before the harness starts. Each item it was given must be answered after the cursor by a reply in its thread, a comment linking its URL, or a 👍 reaction from forge's App; a revision that leaves any item unanswered fails, naming those items, rather than succeeding. This replaces ADR-0050's rule that forge passes the worker only the pull request's identity.

## Consequences

Every kind of feedback reaches the revision whatever skill the repository configures, and its transcript shows exactly what it was asked to address. Feedback can no longer be consumed without a visible response, and an unanswered item shows up as an ordinary failed revision that `forge-revise` reruns. Feedback text becomes part of the worker's instruction, so who counts as a feedback author matters more. Skills used outside forge still need their own way to find new feedback.
