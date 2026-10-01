# 0030. A workload cannot create nested user namespaces

## Status

Accepted

Amends ADR-0024.

## Context

ADR-0024 runs a workload's harness in a bubblewrap sandbox inside an unprivileged user namespace. Left alone, the harness can create further user namespaces inside it, for example with `unshare -Ur`. Inside one it holds `CAP_SYS_ADMIN` and `CAP_NET_ADMIN`, which reach kernel code such as nf_tables and overlayfs that unprivileged users otherwise cannot. That code has a long record of local privilege escalations, and root on the box reaches every secret and every workload.

- Option 1: Leave nested user namespaces allowed. Agents can run rootless containers, nested sandboxes and browsers with their own user-namespace sandbox, and the kernel attack surface stays open.
- Option 2: Pass bubblewrap's `--disable-userns`. bubblewrap sets `user.max_user_namespaces` to 1 inside the sandbox's own user namespace, enters a nested one, and checks that it can create no further namespace, failing to start if it can. Nothing that needs a user namespace runs in a workload.
- Option 3: A seccomp filter that blocks `unshare` and `clone` with `CLONE_NEWUSER`. It needs a filter forge maintains per architecture, for the same effect as Option 2.

## Decision

We will go with Option 2.

## Consequences

The harness and its subagents cannot create user namespaces, so the kernel code reachable only from one stays out of a workload's reach. Rootless containers, nested bubblewrap and anything else that needs a user namespace do not work in a workload. Playwright disables Chromium's own sandbox by default, so browser tests still run. Subagents are plain child processes and nix goes through the daemon, so neither is affected. bubblewrap writes the limit through the runner unit's `/proc`, so the workload units must keep `ProtectKernelTunables` off. They need it off for a second reason too: its read-only overmounts in `/proc` stop bubblewrap mounting the fresh `/proc` the sandbox gets. If either stops holding, the sandbox fails to start rather than running without the limit.
