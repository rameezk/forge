# 0124. A run's trace is derived from its transcript, stamped with each event's arrival time

## Status

Accepted

## Context

The run page lists a workload's generations as a flat Calls table. It cannot show how the run flowed: which tool runs a call asked for, what a subagent did inside its branch, or where the time and the cost went. A trace (a tree of steps on a timeline, as tracing tools such as Langfuse draw it) shows all of that, but a generation records only the time it arrived, and tool calls and tool results record no time at all.

Where the timings come from:

- Option 1: The runner stamps each harness event with the time it arrives, in the one loop every harness's events pass through. A step starts when the event before it arrived.
- Option 2: Each harness adapter forwards its harness's own start events, such as pi's `message_start` and `tool_execution_start`. More precise, but written once per adapter, and Claude Code's stream-json has no clean equivalent.
- Option 3: Adopt Langfuse, or export OpenTelemetry to it. Its trace view is the reference, but it estimates cost from its own price tables, which ADR-0013 rules out, and it is a second dashboard and a large self-hosted stack.

Where the timings live:

- Option A: An `at` field on each transcript line, with the trace derived from the transcript.
- Option B: A `spans` table in the store, written by the runner beside the transcript.

## Decision

We will go with Option 1 and Option A. The runner stamps each event's arrival time on its transcript line, and a run's trace is derived from the transcript and the run's generations. The trace replaces the Calls section on the run page and keeps its cost rules: billed, estimated and list-price-equivalent cost, the cache-miss rule, and the pending state. A run recorded before timings has a trace with no time axis.

## Consequences

The harness adapters are untouched, and the trace works the same for every harness. Timings are what forge observed, not what the harness measured: a call's start includes any gap before it, and parallel tool runs all start when the call that asked for them ended. The transcript stays the one record of what a run did, so drawing the trace means reading the transcript file rather than querying the store. Langfuse's scores, datasets, prompt store and OpenTelemetry export stay out of forge.
