---
name: blueprint
description: Turn a user requirement or bug report into a detailed implementation plan with listed test cases and edge cases. Use when the user or agent asks to plan a feature, scope a change, or work out how to fix a bug before writing code. Produces a reviewable plan, not an implementation.
model: opus
---

# Implementation Plan

## Purpose

Turn a raw requirement or bug report into a clear, reviewable implementation
plan so the work is understood, scoped, and de-risked before any production
code is written. The plan names what changes, in what order, and every test
case and edge case that proves it correct.

## When to use

- The user asks to "plan", "scope", "break down", or "think through" a feature
  or change before implementing
- The user hands over a requirement, ticket, or bug report and wants a route to
  a solution rather than an immediate edit
- A change is large, ambiguous, or risky enough that jumping straight to code
  would likely miss cases

## When NOT to use

- The change is trivial and unambiguous - just do it (or use [[tdd]])
- The user has explicitly asked you to write code now, not a plan

## Workflow

1. **Restate the intent.** In one or two sentences, state what the requirement
   or bug actually asks for, in your own words. For a bug, state the observed
   behaviour and the expected behaviour separately.
2. **Investigate before planning.** Read the relevant code, tests, and data
   flow. Ground the plan in how the codebase actually works, not assumptions.
   Note the files and functions that will change.
3. **Surface unknowns.** List any ambiguities or decisions that materially
   change the approach. Ask the user about the ones that block a sound plan;
   state a sensible default for the rest and move on.
4. **Design the approach.** Choose the implementation strategy. Weigh
   alternatives only where the choice is non-obvious, and favour quality,
   simplicity, robustness, and long-term maintainability over development cost.
5. **Break into steps.** Sequence the work into small, ordered, independently
   verifiable steps. Each step should describe the change and name the files it
   touches.
6. **Enumerate test cases.** List the concrete test cases that prove the change
   correct - happy paths and the behaviour each step introduces.
7. **Enumerate edge cases.** Separately list edge cases, boundary conditions,
   and failure modes. Be deliberately adversarial here (see Edge cases).
8. **Write the plan** in the output format below and present it for review.

## Output format

Produce a single markdown plan following this template. Keep the headings;
replace the guidance in each section with the plan's actual content. Omit
**Open questions** and **Risks & rollout** only when genuinely not applicable.

````markdown
# <title>

## Summary

The intent restated in one or two sentences.

## Context

The relevant files, functions, and current behaviour the plan builds on. For a
bug, the root cause once identified.

## Approach

The chosen strategy, and any alternative rejected with a one-line reason.

## Open questions

List every open question. For each, give the default you recommend and a
one-line reason each other option was rejected.

- **<question>**
  - Recommended default: <default>.
  - Rejected:
    - <option> - <one-line reason>.
    - <option> - <one-line reason>.

## Implementation steps

1. **<step>** - what changes, which files, and how it is verified.
2. **<step>** - ...

## Testing

Write each case in Given / When / Then form.

### Test cases

Grouped by the behaviour or step they cover.

- [ ] **<scenario>**
  - Given <starting state / setup>.
  - When <action under test>.
  - Then <expected result>.

### Edge cases

- [ ] **<boundary or failure mode>**
  - Given <starting state / setup>.
  - When <action under test>.
  - Then <expected handling>.

## Risks & rollout

Anything that could break, migration or data concerns, and how the change lands
safely.
````

## Test cases

- Cover the happy path first, then every distinct behaviour the change adds.
- State each case in Given / When / Then form - the starting state, the action,
  and the expected result - concrete enough to write directly as a test.
- Name cases for the behaviour they pin down, not the method they call.
- For a bug, include the case that reproduces the bug end-to-end, as close to
  how an end user hits it as possible - this case must fail before the fix.

## Edge cases

Be deliberately adversarial. Work through, as relevant:

- Empty, null, missing, and default inputs
- Boundaries: zero, one, max, off-by-one, overflow, empty collections
- Malformed, out-of-range, or hostile input
- Concurrency, ordering, retries, and idempotency
- Failure of every external dependency (network, disk, DB, third party)
- Partial failure and rollback - what state is left behind
- Permissions, auth, and untrusted callers
- Time zones, clock skew, and locale where dates or formatting are involved
- Scale: large inputs, pagination limits, resource exhaustion

## Guardrails

- Plan only. Do NOT write production code or edit source files while planning;
  the output is the plan itself for the user to review.
- Ground the plan in the real codebase - read before planning. Do not invent
  files, functions, or behaviour you have not verified.
- Prefer the simplest end-to-end path for one-off work; do not plan wrappers,
  control planes, or automation the requirement does not justify.
- Do not paper over unknowns. If a decision materially changes the approach,
  surface it rather than silently picking one.

## Avoid

- Vague steps like "implement the feature" - each step must be concrete and
  verifiable
- A plan with no edge cases, or edge cases folded into the test list instead of
  called out separately
- Padding the plan with obvious or duplicate test cases to look thorough
- Committing to an approach without reading the code it touches
