# 0107. The runner re-runs failed CI when a workload asks

## Status

Accepted

Amends ADR-0089 and ADR-0049.

## Context

ADR-0089 gave every workload token Actions: write so the agent can re-run CI that failed for infrastructure reasons, bounded only by a standing instruction. A leaked token can also dispatch any workflow on any ref, cancel runs, disable workflows, and delete runs, logs, artifacts and caches. Re-running intermittent failures is worth keeping.

- Option 1: Keep Actions: write on the workload token.
- Option 2: Drop it from the workload token. The agent asks the runner, outside the sandbox, to re-run a run; the runner checks in code that the run is on the head of the workload's pull request, failed, and has been re-run fewer than twice in this workload, then re-runs it with its own token.
- Option 3: Drop it and have the runner re-run infrastructure failures unasked, judging the failure itself.

## Decision

We will go with Option 2. The ask crosses a new, single-purpose channel from the sandbox to the runner. The agent still judges whether a failure is infrastructure, as ADR-0089 decided.

## Consequences

A leaked workload token cannot touch Actions. ADR-0089's limits on what is re-run and how often hold even against a careless or compromised agent, though a compromised agent can still re-run a real test failure within them. The sandbox gains a channel to the runner, whose asks the runner must treat as untrusted. The App installation keeps Actions: write for the runner's token.
