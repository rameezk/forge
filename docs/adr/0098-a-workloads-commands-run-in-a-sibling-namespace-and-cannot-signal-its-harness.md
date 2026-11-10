# 0098. A workload's commands run in a sibling namespace and cannot signal its harness

## Status

Accepted

Amends ADR-0024, ADR-0027 and ADR-0057.

## Context

ADR-0024 runs the harness and every command the agent drives in one bubblewrap sandbox, with one PID namespace and one uid. Run `e3297619` died with exit 143 when the agent ran `pkill -f "wrangler dev"`: the prompt was a claude argument and the ticket mentioned `wrangler dev`, so claude matched. Any `kill -TERM -1`, `pkill node` or agent-written config that the harness itself executes, such as a git filter driver, `~/.bashrc` or a project settings `env`, ends or subverts the run the same way.

- Option 1: Pass the prompt on stdin only. Stops this trigger; every other signal and config path stays open.
- Option 2: Run each command in its own nested PID namespace from the shell prefix. Needs `--disable-userns` dropped from the harness sandbox, kills backgrounded servers when a command returns, and gives the harness capabilities in the nested namespaces through the user-namespace owner rule.
- Option 3: One per-run tools namespace nested inside the harness sandbox, created by a forge init that then locks user-namespace creation. Verified to work, but the owner rule still gives anything running beside the harness capabilities inside the tools namespace.
- Option 4: One per-run tools namespace in a sibling sandbox, created by the runner, where a broker runs each command on request over a unix socket. The harness holds no privilege over it and reaches it only through the broker.
- Option 5: The harness as PID 1, a separate uid for commands, or a seccomp filter on `kill`. Claude handles SIGTERM so PID 1 does not protect it, a uid switch conflicts with `NoNewPrivileges`, and a signal filter is fragile and per architecture.

## Decision

We will go with Option 4, for every harness: a harness that cannot route its commands through the broker cannot be added without a new decision.

- The tools sandbox lives for the whole run, with catatonit as PID 1 and the broker as its child; the run ends if the broker dies. Both sandboxes keep `--disable-userns`.
- The broker client is a statically linked binary that passes its environment, working directory, stdio and signals to the broker as data. It is Claude Code's `CLAUDE_CODE_SHELL` and `CLAUDE_CODE_SHELL_PREFIX` and pi's `shellPath`. A dropped client kills the command's process group, as a process-group kill does today.
- Nothing the agent can write runs beside the harness. The harness gets forge's environment and an empty read-only HOME; the repository's devShell applies only to brokered commands. A static, harness-only `git` shim sends the harness's own git calls to the broker.
- Claude Code runs with `--setting-sources user`, a read-only forge-owned `settings.json` and `CLAUDE.md` that `@imports` the repository's `CLAUDE.md` and `AGENTS.md`, the repository's skills, agents and commands through a generated plugin directory, `disableAllHooks`, every credential and telemetry helper set to empty, and the prompt on stdin.
- The Claude Code config fingerprint covers what a run loads: forge's settings, the plugin directory's skills, agents and commands, and the imported instructions. The repository's Claude Code settings and hooks leave it.

## Consequences

A workload's commands cannot see or signal its harness. Background processes survive between commands. `CLAUDE.local.md`, nested `CLAUDE.md` files, repository output styles, hooks and, per ADR-0097, MCP servers no longer apply. Each command pays a broker round trip. The networks stay shared, which holds only while no harness listens on a port. An agent whose `pkill -f` matches its own command still kills that command. A harness that dies from a signal is reported with the signal and the tool call in flight, and is not retried automatically. A NixOS VM test runs both harnesses against these guarantees.
