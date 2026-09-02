---
name: forge
description: Implement a given implementation plan end-to-end - test-first via TDD, then a clean quality gate, then isolated code and security review, then commit and open a PR. Use when the user or agent hands over an implementation plan and asks to build, implement, or "forge" it into working, reviewed code.
model: sonnet
---

# Forge

## Purpose

Take an existing implementation plan and drive it all the way to an open pull
request through one disciplined pipeline: read the plan in full, build it
test-first, clean it to a green quality gate, put it through independent code and
security review, then commit and open a PR. Forge orchestrates the other skills
and the review sub-agents so the plan is implemented faithfully and the result
lands to a consistent standard.

## When to use

- The user or agent hands over an implementation plan and asks to "forge",
  "implement", or "build" it
- An [[blueprint]] exists (under `implementation-plans/` or wherever
  the user points) and the next step is to turn it into working code
- Any change large enough that it was planned first and now needs a controlled
  path from plan to reviewed implementation

## When NOT to use

- There is no plan yet - produce one first with [[blueprint]]
- The change is trivial and unambiguous - use [[tdd]] directly
- The user asked only for a plan, only to review, or only to commit - use the
  narrower skill for that

## Workflow

Run these stages in order. Do not skip ahead; each stage gates the next.

### 1. Read the plan in full

Locate the implementation plan and read it **completely** before writing any
code - every section: summary, context, approach, open questions, implementation
steps, test cases, and edge cases. Do not skim or act on the first step alone.

- If the plan path is ambiguous, look under `implementation-plans/`. If more than
  one plan could match, ask which.
- If the plan has unresolved **Open questions** that materially change the
  implementation, surface them and get answers before starting. Do not silently
  pick one.
- Restate, in a sentence or two, what you are about to build, so the user can
  catch a misread before code exists.
- Start from a fresh branch off up-to-date default (see [[git-branching]]). If you
  find yourself on a non-default branch, first switch to the default branch and
  pull the latest changes, then create the new branch from there - so the work
  never builds on top of stale or unrelated branch state.

### 2. Implement test-first via TDD

Implement the plan by invoking the [[tdd]] skill. Work through the plan's
implementation steps in order, and drive each with the red-green-refactor cycle:

- Turn the plan's **test cases** and **edge cases** into the failing tests that
  lead each slice of behaviour. Every listed case should end up covered.
- One small behaviour per cycle. Watch each test fail for the right reason before
  making it pass, and keep the suite green through every refactor.
- Follow the plan's approach and steps. If reality diverges from the plan - a step
  is wrong, missing, or a better route appears - stop, say so, and confirm the
  deviation rather than quietly implementing something else.

Do not proceed until the full plan is implemented and the entire test suite is
green.

### 3. Clean to a green quality gate

Before any review or commit, invoke the [[code-quality]] skill. Lint, format, and
type-check the change until all three are clean, fixing findings at their cause -
never suppressing them to force green. Re-run the tests afterward to confirm they
are still green.

Do not proceed to review until the quality gate is fully green.

### 4. Independent code and security review

With the implementation complete, tested, and clean, put it through two
**independent, isolated** reviews. Launch both sub-agents in a single message so
they run concurrently, each in its own isolated context with no knowledge of the
other's findings:

- The **code-reviewer** agent - for correctness, quality, and conformance to the
  implementation plan. Tell it where the plan is so it can check plan conformance.
- The **security-reviewer** agent - for security vulnerabilities.

Both agents are strictly read-only; they report, they do not change code. Each
reports its findings back to you, the orchestrating Forge run. Collect both
reports.

Then, as the orchestrator:

- Triage every finding. Address real **Blocker**, **Critical**, and **High**
  issues before committing - fixing a finding means going back through the
  relevant stage (a code change is a new [[tdd]] cycle, then re-run
  [[code-quality]]), not a quick patch that skips the gates.
- For findings you judge not worth acting on, say which and why - do not silently
  drop them.
- If your fixes are substantial, re-run the affected review before committing.

### 5. Commit

Once the reviews are addressed and the suite and quality gate are green, commit
the work with [[git-committing]]. Only now - not before review.

### 6. Open a pull request

With the work committed, open a pull request using the [[git-pr]] skill. Ground
the PR description in the implementation plan: what was built, how it maps to the
plan, the test and quality-gate results, and a note on the review findings and
how they were handled.

### 7. Report

Summarise the outcome: what the plan asked for, that it was implemented and every
planned case covered, the final test and quality-gate results, the review
findings and how each was handled, the commit, and the opened PR link.

## Guardrails

- Read the whole plan before writing code. Acting on a partial read is how the
  implementation drifts from the intent.
- Keep the stages in order. Tests lead the code, the quality gate precedes review,
  and review precedes the commit. Never commit before both reviews are in and
  addressed.
- The reviews are independent. Run the two sub-agents in isolation from each
  other; do not let one's output steer the other, and do not do the review
  yourself in their place.
- Do not weaken the work to pass a gate: no deleted assertions, no suppressed lint
  or type findings, no skipped tests, no ignored blocker to reach a commit.
- Implement the plan, not more. Flag and confirm any deviation from the plan
  rather than silently expanding or reshaping the scope.
- Never claim a stage passed without having run it and seen the result - green
  tests, a clean quality gate, and returned review reports are all things you
  observed, not assumed.

## Avoid

- Jumping straight to production code before the plan is fully read or before a
  failing test demands it
- Committing before the reviews have run and their serious findings are addressed
- Running the two reviewers sequentially or sharing one's findings with the other,
  instead of isolated and concurrent
- Patching a review finding in place without going back through TDD and the
  quality gate
- Silently implementing beyond the plan, or silently dropping the plan's test and
  edge cases
- Reporting the work as done while any part of the suite or quality gate is red
