---
name: tdd
description: Drive code changes test-first using the red-green-refactor cycle. Use when the user or agent asks to write a feature, fix a bug, or change behaviour and wants tests to lead the implementation. Enforces writing a failing test before production code and keeps each cycle small.
model: sonnet
---

# TDD

## Purpose

Give a consistent, disciplined way to build and change behaviour test-first, so
every line of production code exists to satisfy a test, the design stays driven
by real usage, and regressions are caught the moment they appear.

## When to use

- The user asks to build a feature, fix a bug, or change behaviour test-first
- The user asks to "do TDD", "write tests first", or "red-green-refactor"
- Any change where the desired behaviour can be expressed as a test

## The cycle

Repeat this loop, one small behaviour at a time:

1. **Red**: Write one failing test that expresses the next slice of desired
   behaviour. Run it. Confirm it fails, and fails for the right reason (asserting
   the missing behaviour, not a typo, import error, or setup mistake).
2. **Green**: Write the simplest production code that makes the test pass. Do the
   minimum. Resist adding behaviour no test demands yet.
3. **Refactor**: With tests green, improve the design - remove duplication,
   clarify names, simplify structure. Change no observable behaviour. Re-run the
   tests after each refactor; they must stay green.

Keep each cycle small. One behaviour, one assertion focus, seconds-to-minutes per
loop - not a large batch of tests up front.

## Workflow

1. Understand the behaviour: state, in one sentence, what the code should do
   before writing any test. If it is a bug fix, first write a failing test that
   reproduces the bug as closely as an end user would hit it (see Guardrails).
2. Write the failing test (Red). Run the suite and see it fail.
3. Make it pass (Green). Run the suite and see it pass.
4. Refactor. Run the suite and confirm still green.
5. Repeat for the next behaviour until the feature or fix is complete.
6. Report the final test run and what the tests now cover.

## Test quality

- One reason to fail per test. Assert one behaviour; avoid sprawling multi-concern
  tests.
- Test observable behaviour through the public interface, not private internals.
  Tests coupled to implementation break on every refactor.
- Name tests for the behaviour they pin down, not the method they call, following
  a given/when/then form: `given_expired_token_when_validating_then_rejects`, not
  `test_validate`. State only the parts that carry meaning - drop an implied Given.
- Given-When-Then: keep the setup (Given), the action under test (When), and the
  assertion (Then) visibly separate in the test body too.
- Make failures readable. A failing test's message should point at the cause
  without a debugger.
- Keep tests fast and deterministic. No reliance on wall-clock time, network, or
  test ordering.

## Guardrails

- NEVER write production code without a failing test that demands it. If you find
  yourself writing code no test covers, stop and write the test first.
- For bug fixes, ALWAYS start with a failing test that reproduces the bug end-to-end,
  as close to how an end user experiences it as possible. Watch it fail before
  fixing, so you know the fix addresses the real problem.
- Do not delete or weaken an assertion to force green. Fix the code, or fix a test
  that was genuinely wrong - and say which.
- Run the tests at every step. Never claim red or green without having run the
  suite and seen the result.
- If an existing test unexpectedly fails during a change, stop and report. Do not
  silently edit unrelated tests to make the suite pass.

## Avoid

- Writing large batches of tests or the whole implementation before running anything
- Testing implementation details that make refactoring painful
- Over-engineering in Green: building for requirements no current test expresses
- Skipping Refactor - green tests are the moment to clean up, not to move on
- Committing with a red or skipped suite and calling the work done
