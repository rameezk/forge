# 0037. A subagent's kind is the skills it loaded

## Status

Accepted

## Context

Operators want to see how often a workload ran a review or a security-review subagent. ADR-0009 gives the `subagent` tool a single unnamed task, so a subagent carries no type; its only recorded identity is the parent's tool call id. Skills such as `work-on` delegate each review to a subagent that loads the review skill itself.

- Option 1: Classify a subagent by the skills it loaded, observed as `read` calls on the `SKILL.md` paths pi lists. Exact, and needs no change to the harness contract, but a subagent that loads no skill stays unclassified.
- Option 2: Add an optional declared role to the `subagent` tool and have skills set it. Reopens ADR-0009 and depends on the model sending a consistent free-text label.
- Option 3: Infer the kind from the task text. Needs no contract change, but is a guess that can be wrong in both directions.

## Decision

We will go with Option 1. A subagent's kind is the set of skills it loaded. Forge records no declared role, and ADR-0009 stands unchanged.

## Consequences

A count of security-review subagents is the number of subagents that loaded `security-review`, with no false positives. A subagent briefed inline, without loading a skill, is shown as unclassified rather than guessed. A skill that changes how it delegates changes what the dashboard counts. Declared roles remain open as a later decision if unclassified subagents prove common.
