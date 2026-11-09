# 0084. The dashboard listens on a unix socket the workload sandbox cannot see

## Status

Accepted

## Context

ADR-0024's sandbox hides the state directory but shares the box's network, and ADR-0020 keeps the dashboard on `127.0.0.1` behind `tailscale serve`. Workload units already deny tailnet addresses, but a prompt-injected harness can still `curl` the unauthenticated dashboard over loopback and read every run's transcript, the frontier and every dispatch. The dashboard is the only forge service that listens on TCP.

- Option 1: The dashboard listens on a path-based unix socket in a directory the sandbox does not mount, and `tailscale serve` proxies to it. No forge service listens on TCP.
- Option 2: The harness gets its own network namespace with an egress-only path such as `pasta`. This also hides non-forge loopback listeners, but reverses ADR-0024's shared network and adds a userspace network stack to every workload.
- Option 3: Deny `localhost` to workload units. This also breaks the workload's own loopback traffic, so a managed repository's tests that start a local server fail.
- Option 4: Authenticate the dashboard. The tailnet already authenticates the operator, so this adds a credential to mint, store and rotate only to close a local hole.

## Decision

We will go with Option 1. This replaces ADR-0020's "the dashboard stays bound to localhost"; the rest of ADR-0020 stands.

## Consequences

A workload cannot reach the dashboard over loopback or the filesystem, whatever it runs, and its own loopback is untouched. `dashboardPort` goes away. The Nix daemon socket the sandbox mounts on purpose and non-forge loopback listeners such as sshd stay reachable from a workload. A future forge service that listened on TCP would reopen this hole.
