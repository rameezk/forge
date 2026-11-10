# 0094. A Claude Code turn ends only when its response does

## Status

Accepted

## Context

The runner reports each Claude Code response as a message carrying usage, which it reads from the response body Claude Code records (ADR-0054). It treated a tool result, or activity from a subagent the response spawned, as the end of the response, and then gave the body 10 seconds to appear. Claude Code runs a tool as soon as its `tool_use` block is complete, while the same response is still streaming, and records the body only once the response ends. Runs `848d966c` and `73c68f5f` failed with "claude recorded no usage" exactly 10 seconds after a fast Edit returned while the rest of its response was still being generated.

- Option 1: Hold everything that depends on a pending turn, meaning its tool results and its spawned subagents' events, and release it in stream order once the turn's body is recorded. The transcript order and event schema stay the same, and the live view lags only while the response finishes streaming.
- Option 2: Emit the message at once without usage and add usage later. This changes the event schema and every consumer of messages, cost totals and insights.
- Option 3: Emit tool results before their call and message. This breaks the order the transcript promises.

## Decision

We will go with Option 1. A turn completes only when its body is recorded, or when the response has clearly ended: an assistant message with a new id in the same scope, a `result` line, a `system` line, or the end of the stream. The 10 second body deadline starts only at one of these end signals. While a response is still streaming, the turn waits with no deadline beyond the run's timeout and stop signal. If the deadline does run out, the error names the signal that ended the response and how long the runner waited. The recorded bodies are still deleted with the run directory.

## Consequences

A tool that finishes while its response is still streaming no longer fails the run, however long the rest of the response takes. Tool results and subagent events reach the live transcript only once their turn's message has been reported. A partial response that Claude Code abandons for an API retry and never records still fails after 10 seconds, as before.
