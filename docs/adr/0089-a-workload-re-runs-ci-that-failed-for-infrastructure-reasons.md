# 0089. A workload re-runs CI that failed for infrastructure reasons

## Status

Accepted

Amends ADR-0049.

## Context

A workload's token has Actions: read, so when GitHub fails a check run for its own reasons, such as a workflow run that creates no jobs during an Actions outage, the agent cannot re-run it. Agents fall back to pushing empty commits or closing and reopening the pull request, and a run whose CI never starts ends failed with its pull request still a draft.

- Option 1: The workload token gets Actions: write and the agent re-runs failed runs itself. The agent already watches the checks and reads their logs, so it is best placed to tell an infrastructure failure from a real one. Actions: write is GitHub's narrowest permission for re-running, and it also lets the token cancel runs, dispatch any workflow with `workflow_dispatch`, enable or disable workflows and delete runs, logs, artifacts and caches.
- Option 2: Forge re-runs failed check runs with its own token and the workload keeps Actions: read. The permission stays outside the sandbox, but forge must classify failures itself and usually acts after the run has already ended failed.
- Option 3: Both.

## Decision

We will go with Option 1. Forge always requests Actions: write for the workload token, with no fallback to read. The runner's standing instruction to every workload says: re-run only a failed run on the head of the pull request the workload works on, and only when it failed for infrastructure reasons (no jobs created, a startup failure, a lost runner, a cancellation the agent did not cause), at most twice per run; never re-run a failing test or step, flaky or not, but fix it; never dispatch, disable, enable or delete anything in Actions; never re-trigger CI with an empty commit or by closing and reopening the pull request. A run still failing for infrastructure reasons after two re-runs leaves the pull request a draft and the report names the run, the failure and the attempts.

## Consequences

Short GitHub outages no longer fail a run, and empty commits and close-reopen cycles no longer clutter pull request history. A compromised or careless run can dispatch a workflow such as a release, which the standing instruction forbids but the token allows; this is no wider than the existing Workflows: write, which can already rewrite any workflow. Existing installations must add Actions: read and write to the App and accept it on the installation, and until they do every dispatch fails to mint its token and names the permissions forge requested. Infrastructure failures that outlast two re-runs still need a person.
