# 0103. The runner grades a pull request's risk with a direct Jev call

## Status

Accepted

## Context

A maintainer reviewing forge's pull requests cannot tell which need close attention, and review is what limits throughput (ADR-0092). Jev, TypeSafe's classification model, returns typed answers with probabilities, no text and no tool calls, through OpenRouter's Decisions API with its cost in each response. ADR-0102 rejected direct model calls from the runner as unsandboxed and uncosted. The grade must not be biased by the model that wrote the change.

- Option 1: The implementing workload grades its own change. The grader shares the implementer's context and bias.
- Option 2: A grading workload of its own, whose harness calls Jev from the workload sandbox. Isolated from the implementer, but it runs a harness to make one HTTP call and holds a `maxConcurrent` slot a build could use.
- Option 3: The runner calls the Decisions API directly once the workload has ended. Jev executes nothing, so there is nothing to sandbox, and `usage.cost` costs the call inline.

## Decision

We will go with Option 3, in a `forge-grading` service of its own rather than frontier sync or billing, so it holds only the OpenRouter key and the App access grading needs and a slow or failing Jev never delays a dispatch or revision. The runner, never a harness, sends Jev the ticket, its parent spec, the changed files with their line counts, and the whole diff with lockfile and generated-file content left out. It never sends the pull request title, body or commit messages: a trial over 32 of forge's pull requests showed the diff carries the grade, and that the implementer's own text pulled grades down on 9 of 12. Input over 32KB runs in Jev's long-context mode rather than being trimmed or chunked, since chunked grades of the same pull requests differed by at most 0.29. Typed, tool-free decision calls are exempt from ADR-0102's rule against direct model calls; generative calls are not.

## Consequences

Grading takes no workload slot and the implementing model can neither see nor shape it, beyond the diff itself. About half of forge's pull requests are graded in long-context mode. The runner gains an outbound call to OpenRouter's Decisions API, an alpha endpoint, and a grade is costed per call rather than against any workload's budget. A future direct call must be typed and tool-free to rely on this exemption.
