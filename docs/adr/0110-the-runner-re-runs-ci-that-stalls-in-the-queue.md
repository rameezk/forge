# 0110. The runner re-runs CI that stalls in the queue

## Status

Accepted

Amends ADR-0107 and ADR-0089.

## Context

GitHub sometimes leaves a workflow run `queued` with no jobs indefinitely, even after `cancel-in-progress` should have cancelled it. ADR-0107's runner re-runs only a run that has completed as failed, and ADR-0089 forbids an empty commit or a close and reopen, so a workload facing such a run can only poll until it gives up and leaves its pull request a draft. On GitHub-hosted runners a run that has no jobs after a few minutes is already abnormal.

- Option 1: Change nothing. A stalled run needs a person.
- Option 2: Teach the agent to treat a long queue as a stall and mark the pull request ready with a "CI not run" note. Forge still fails a ready pull request whose required check is pending, so this changes only the failure reason and breaks "ready means green".
- Option 3: Lift ADR-0089's ban on an empty commit, so the agent starts a fresh run itself. The agent would control CI triggering directly and pull request history gains noise commits.
- Option 4: The runner also accepts an ask for a run on the pull request's head that GitHub reports `queued` with no jobs, created at least 15 minutes earlier by GitHub's own clock. It force-cancels the run, waits for it to complete, then re-runs it.

## Decision

We will go with Option 4. A stall re-run counts toward the same limit of two re-runs per workload as a failed one, and the runner, not the agent, checks the 15 minutes against the run's `created_at`. The standing instruction tells the agent that a run queued with no jobs for 15 minutes is an infrastructure stall to ask `forge-rerun-ci` about. ADR-0089's bans stand.

## Consequences

A GitHub queue stall no longer costs a workload its run. The runner's token now also force-cancels runs, but only a stalled run on the head of the workload's own pull request, within the existing limit. A run that stalls again after two re-runs still leaves the pull request a draft for a person.
