# 0101. The command broker is the tools sandbox's PID 1

## Status

Accepted

Amends ADR-0098.

## Context

ADR-0098 runs catatonit as the tools sandbox's PID 1 with the command broker as its child, and requires that a command running `kill -KILL -1` leaves the run going. Commands share the broker's PID namespace and uid, and `kill(-1, sig)` reaches every process the sender may signal except PID 1 and the sender, so the broker dies, the tools sandbox ends and the run fails. Two builds of #692 stopped on this contradiction.

- Option 1: The broker is the tools sandbox's PID 1, through `bwrap --as-pid-1`, and reaps orphans itself. The kernel never delivers `SIGKILL` or `SIGSTOP` to a PID 1 from inside its namespace, and delivers other signals only when it has a handler for them.
- Option 2: Keep catatonit as PID 1 and accept that `kill -KILL -1` from a command ends the run. Leaves an agent-triggered run failure, which ADR-0098 set out to close.
- Option 3: A forge-written PID 1 that restarts the broker when it dies. A second component and a recovery path, with in-flight commands lost either way.
- Option 4: Commands in a PID namespace nested under the broker, or a broker outside the tools sandbox that enters it with `setns`. Needs capabilities or the user-namespace owner rule that ADR-0030 and ADR-0098 rule out.

## Decision

We will go with Option 1: the command broker runs as the tools sandbox's PID 1 and catatonit is dropped. The broker leaves every catchable signal at its default disposition and collects children through a blocked `SIGCHLD` with `signalfd` or a `waitpid` loop, never a signal handler, so no signal a command sends can reach it. The tools sandbox is torn down from outside its namespace. A broker that dies still ends the tools sandbox and fails the run.

## Consequences

`kill -1`, `kill -KILL 1`, `kill -TERM 1`, `kill -INT 1` and `kill -HUP 1` from a command leave the broker, the run and later commands running. A `kill -1` still takes down every other process in the tools sandbox, background servers included. The broker carries PID 1's duties, reaping and signal discipline, and any signal handler added to it reopens the hole. ADR-0098's remaining decisions stand.
