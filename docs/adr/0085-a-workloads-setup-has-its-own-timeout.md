# 0085. A workload's setup has its own timeout

## Status

Accepted

Amends ADR-0045.

## Context

ADR-0045's timeout counts from the harness's start, and the systemd backstop 30 minutes past it is all that bounds setup: the clone, the skill resolution and the devShell, and a conflict resolution's trial merge, which runs before its run exists. A worker with no timeout has no backstop, so its setup can hang forever, and a hung setup on any other worker shows only as `interrupted` up to 30 minutes later. The skill walk is synchronous, so a large skills tree also stalls the heartbeat until the billing service ends a live run as `interrupted`.

- Option 1: Leave setup to the backstop.
- Option 2: The runner bounds all of setup with one operator-set setup timeout, and a run that crosses it ends `error`, naming the stage it was in.
- Option 3: A fixed timeout per setup step. A cold devShell build varies too much by repository for one fixed number.

## Decision

We will go with Option 2. `forge.runtime.workload.setupTimeout` is one global time span, `30min` by default, and never null, so setup is always bounded. It also bounds a conflict resolution's trial merge. Crossing it is forge's preparation failing, not the agent overrunning, so it ends the run `error` rather than `exceeded`, and a dispatch, revision or conflict resolution fails as `errored`. The backstop becomes the setup timeout plus the workload timeout plus 15 minutes for finalizing, and stays absent for a worker with no timeout. The skill walk is asynchronous and fails setup once it visits more than 10,000 entries.

## Consequences

A hung clone or devShell fails within the setup timeout with a reason that names its stage, even on a worker with no timeout. A repository whose cold devShell takes longer than 30 minutes needs the operator to raise the global value, since there is no per-repository override. A large skills tree no longer gets a live run marked `interrupted`.
