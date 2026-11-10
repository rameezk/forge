# 0095. A workload's own context goes in its user prompt, not its system prompt

## Status

Accepted

Amends ADR-0034 and ADR-0057.

## Context

The config fingerprint hashes the system prompt. Since the ticket context reached the dispatch instruction, the ticket and parent spec, a revision's feedback and a conflict's brief all ride in the system prompt, so nearly every workload forms its own cohort. Claude Code's billing header also carries `cc_prev_req`, a per-run request id the normalizer does not mask.

- Option 1: Keep the context in the system prompt and mask it in the normalizer with placeholders. Matches free-form text, and widens with every new kind of context.
- Option 2: Put the context in the first user message beside the rendered prompt, whose template alone is fingerprinted, and keep only forge's fixed instructions in the system prompt.

## Decision

We will go with Option 2. The system prompt says how a workload works; the user prompt says what it works on. The fixed instructions still differ by workload kind, so dispatch, revision and conflict workloads of one worker remain separate cohorts, with no explicit kind field. The Claude Code normalizer masks `cc_prev_req`. A unit test asserts that workloads differing only in work dir and context share a fingerprint, and the Claude Code contract check asserts that two cold runs in different work dirs share a normalized system prompt hash. Cohorts already recorded are left as they are.

## Consequences

Cohorts group workloads again, and the system prompt is identical across workloads, so it can be cached across them. The single-run cohorts recorded since the ticket context landed stay fragmented. A harness-side per-run value added in a Claude Code upgrade fails the contract check instead of silently splitting cohorts.
