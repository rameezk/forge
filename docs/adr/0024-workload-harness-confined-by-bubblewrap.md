# 0024. A workload's harness runs confined by bubblewrap and receives credentials only through its environment

## Status

Accepted

## Context

Every workload unit runs as `forge-runtime` with `ReadWritePaths=/var/lib/forge`, and its HOME is `/var/lib/forge`. The harness and its subagents are plain children of the runner. That lets them plant dotfiles that every later workload reads, tamper with `forge.db` and transcripts, read and write other run directories, and read `github.env` and `/run/secrets`. The runner itself has to keep writing `forge.db` and transcripts, so unit settings alone cannot tell it apart from the harness. ADR-0017 will put a GitHub write token in the agent's environment on purpose, so "the agent never holds the GitHub token" is not a rule that lasts.

- Option 1: Hide only `github.env` from workload units. This does not survive ADR-0017, and it leaves `/run/secrets`, the state directory and HOME open.
- Option 2: The runner launches the harness inside bubblewrap with a private mount namespace. The harness sees a read-only Nix store, the `/etc` entries it needs, its own run directory read-write, and a fresh tmpfs for `/tmp` and HOME. `/var/lib/forge` and `/run/secrets` are absent, and the network stays shared. Subagents inherit the namespace. This depends on unprivileged user namespaces.
- Option 3: Run the harness in its own systemd unit per run, with narrow `ReadWritePaths`, its own HOME and `InaccessiblePaths`. The unprivileged runner would need a polkit rule to start it. Streaming harness output back for transcripts and cost gets harder, and failures cross a unit boundary.
- Option 4: Run the harness as a separate `forge-agent` user and rely on file permissions. This needs a privileged user switch and correct group modes on every path, which is fragile.

## Decision

We will go with Option 2. The workload never sees a secret file. It holds exactly the credentials the runner deliberately puts in its environment: `OPENROUTER_API_KEY` today, and `GITHUB_TOKEN` once ADR-0017 is built.

## Consequences

No workload can affect a later one, or read another workload's state, through the state directory or HOME. Every credential a workload holds is a visible choice in the runner's code. The box needs unprivileged user namespaces, and `bubblewrap` becomes part of the runner's closure. The units keep `ReadWritePaths=/var/lib/forge` for the runner's own writes. The GitHub token moves from a hand-placed file in the state directory to sops, as ADR-0011 intended. Tightening each non-workload unit's access to the state directory is a separate follow-up. The mount namespace also gives the checkout slice a way to scope pi's context-file discovery, which ADR-0015 left open.
